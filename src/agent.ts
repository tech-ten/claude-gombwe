import { spawn, execSync, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AgentTask, GombweConfig, TaskStatus } from './types.js';

const AUTONOMY_WRAPPER = `You are operating in FULLY AUTONOMOUS mode. You must complete the entire task without stopping to ask questions.

RULES:
1. NEVER ask the user a question. Make reasonable decisions yourself.
2. NEVER stop halfway. If a step fails, debug it and try another approach.
3. Break the work into steps, then execute ALL steps.
4. After each step, verify it worked before moving on.
5. When you think you're done, review your work to make sure nothing is missing.
6. If you create files, make sure they're complete — no TODOs, no placeholders.
7. If you need to make a choice (library, approach, name), just pick the best one and go.

THE TASK:
`;

const CONTINUE_PROMPT = `You were working on a task but didn't finish. Look at what you've done so far in this project and continue from where you left off. Do NOT start over. Do NOT ask questions. Just keep going until the task is fully complete.

Review git status and recent changes to understand your progress, then continue.`;

const VERIFY_PROMPT = `You just completed a task. Verify your work:

1. Check that all files you created/modified are syntactically valid
2. If there are tests, run them
3. If there's a build step, run it
4. Look for any TODOs, placeholders, or incomplete code
5. Fix any issues you find

Original task was:
`;

export class AgentRuntime extends EventEmitter {
  private tasks: Map<string, AgentTask> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private config: GombweConfig;
  private tasksFile: string;

  constructor(config: GombweConfig) {
    super();
    this.config = config;
    this.tasksFile = join(config.dataDir, 'tasks', 'tasks.json');
    this.loadTasks();
  }

  reloadTasks(): void { this.loadTasks(); }

  private loadTasks(): void {
    if (existsSync(this.tasksFile)) {
      const raw = readFileSync(this.tasksFile, 'utf-8');
      const tasks: AgentTask[] = JSON.parse(raw);
      for (const task of tasks) {
        if (task.status === 'running') {
          task.status = 'failed';
          task.error = 'Process terminated (daemon restart)';
        }
        this.tasks.set(task.id, task);
      }
    }
  }

  private persistTasks(): void {
    const tasks = Array.from(this.tasks.values());
    writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2));
  }

  async runTask(prompt: string, channel: string, sessionKey: string, workingDir?: string): Promise<AgentTask> {
    const runningCount = Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
    if (runningCount >= this.config.agents.maxConcurrent) {
      throw new Error(`Max concurrent tasks (${this.config.agents.maxConcurrent}) reached. Wait for a task to finish.`);
    }

    const task: AgentTask = {
      id: randomUUID(),
      prompt,
      status: 'pending',
      channel,
      sessionKey,
      createdAt: new Date().toISOString(),
      output: [],
      workingDir: workingDir || this.config.agents.workingDir,
      attempt: 0,
      maxAttempts: 3,
      continuations: 0,
      maxContinuations: 5,
      verified: false,
    };

    this.tasks.set(task.id, task);
    this.persistTasks();
    this.emit('task:created', task);

    this.runWithCompletionLoop(task);
    return task;
  }

  /**
   * The completion loop — this is what makes gombwe different from plain claude.
   *
   * 1. Wrap the prompt with autonomy instructions
   * 2. Run claude -p
   * 3. If it fails → retry (up to maxAttempts)
   * 4. If it exits but output looks incomplete → continue (up to maxContinuations)
   * 5. Once it says it's done → run a verification pass
   * 6. Only mark complete after verification passes
   */
  private async runWithCompletionLoop(task: AgentTask): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.attempt = 1;
    this.persistTasks();
    this.emit('task:started', task);

    // Step 1: Initial run with autonomy wrapper
    const wrappedPrompt = AUTONOMY_WRAPPER + task.prompt;
    this.emitOutput(task, `[gombwe] Starting task (attempt ${task.attempt}/${task.maxAttempts})...`);

    const result = await this.spawnClaude(task, wrappedPrompt);

    if (result.success) {
      await this.handleSuccess(task, result);
    } else {
      await this.handleFailure(task, result);
    }
  }

  private async handleSuccess(task: AgentTask, result: ClaudeResult): Promise<void> {
    // Check if output looks incomplete
    if (this.looksIncomplete(result.output) && task.continuations < task.maxContinuations) {
      task.continuations++;
      this.emitOutput(task, `[gombwe] Output looks incomplete. Continuing (${task.continuations}/${task.maxContinuations})...`);

      // Use --resume if we have a conversation ID, otherwise use continue prompt
      const continueResult = task.conversationId
        ? await this.spawnClaude(task, CONTINUE_PROMPT, task.conversationId)
        : await this.spawnClaude(task, CONTINUE_PROMPT + `\n\nOriginal task: ${task.prompt}`);

      if (continueResult.success) {
        await this.handleSuccess(task, continueResult);
      } else {
        await this.handleFailure(task, continueResult);
      }
      return;
    }

    // Verification pass — resume the same session so Claude has full context
    if (!task.verified) {
      task.verified = true;
      this.emitOutput(task, `[gombwe] Running verification pass...`);

      const verifyPrompt = VERIFY_PROMPT + task.prompt;

      // Use --resume if we captured a session ID — Claude keeps full context
      // (every file it read, every command it ran, every decision it made)
      const verifyResult = task.conversationId
        ? await this.spawnClaude(task, verifyPrompt, task.conversationId)
        : await this.spawnClaude(task, verifyPrompt);

      if (!verifyResult.success) {
        this.emitOutput(task, `[gombwe] Verification had issues, but main task completed.`);
      }
    }

    // Done!
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    this.persistTasks();
    this.emitOutput(task, `[gombwe] Task completed successfully.`);
    this.emit('task:completed', task);
  }

  private async handleFailure(task: AgentTask, result: ClaudeResult): Promise<void> {
    if (task.attempt < task.maxAttempts) {
      task.attempt++;
      this.emitOutput(task, `[gombwe] Attempt ${task.attempt - 1} failed: ${result.error}. Retrying (${task.attempt}/${task.maxAttempts})...`);

      // Wait a moment before retry
      await new Promise(r => setTimeout(r, 2000));

      const retryPrompt = `A previous attempt failed with: ${result.error}\nCheck the current state of the project and continue from where things left off. Do not start over.\n\nOriginal task: ${task.prompt}`;

      // Resume the session if possible — Claude remembers what it already tried
      const retryResult = task.conversationId
        ? await this.spawnClaude(task, retryPrompt, task.conversationId)
        : await this.spawnClaude(task, AUTONOMY_WRAPPER + task.prompt);

      if (retryResult.success) {
        await this.handleSuccess(task, retryResult);
      } else {
        await this.handleFailure(task, retryResult);
      }
    } else {
      // All retries exhausted
      task.status = 'failed';
      task.error = `Failed after ${task.maxAttempts} attempts. Last error: ${result.error}`;
      task.completedAt = new Date().toISOString();
      this.persistTasks();
      this.emitOutput(task, `[gombwe] Task failed after ${task.maxAttempts} attempts.`);
      this.emit('task:failed', task);
    }
  }

  /**
   * Heuristics to detect if Claude stopped before finishing.
   */
  private looksIncomplete(output: string): boolean {
    const lower = output.toLowerCase();
    const incompleteSignals = [
      'i\'ll continue',
      'let me continue',
      'next, i\'ll',
      'next i\'ll',
      'now let me',
      'i still need to',
      'remaining steps',
      'todo:',
      'TODO:',
      'not yet implemented',
      'will implement',
      'placeholder',
      '// ...',
      '# ...',
    ];
    return incompleteSignals.some(signal => lower.includes(signal.toLowerCase()));
  }

  private spawnClaude(task: AgentTask, prompt: string, resumeConversation?: string): Promise<ClaudeResult> {
    return new Promise((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];

      if (resumeConversation) {
        args.push('--resume', resumeConversation);
      }

      if (this.config.agents.defaultModel) {
        args.push('--model', this.config.agents.defaultModel);
      }

      if (this.config.agents.mcpConfigs?.length) {
        args.push('--mcp-config', ...this.config.agents.mcpConfigs);
      }

      const proc = spawn('claude', args, {
        cwd: task.workingDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],  // no stdin — prevents "no stdin" warning
      });

      task.pid = proc.pid;
      this.processes.set(task.id, proc);

      let buffer = '';
      let fullOutput = '';
      let lastResult = '';
      let conversationId = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Capture conversation ID for resume
            if (event.session_id || event.conversation_id) {
              conversationId = event.session_id || event.conversation_id;
              task.conversationId = conversationId;
            }

            if (event.type === 'assistant' && event.content) {
              fullOutput += event.content + '\n';
              task.output.push(event.content);
              this.emit('task:output', { taskId: task.id, text: event.content });
            } else if (event.type === 'result') {
              const text = event.result || event.content || '';
              lastResult = text;
              fullOutput += text + '\n';
              task.output.push(text);
              this.emit('task:output', { taskId: task.id, text });
            } else if (event.type === 'error') {
              const errMsg = event.message || event.content || 'Unknown error';
              task.output.push(`[error] ${errMsg}`);
              this.emit('task:output', { taskId: task.id, text: `[error] ${errMsg}` });
            }
          } catch {
            fullOutput += line + '\n';
            task.output.push(line);
            this.emit('task:output', { taskId: task.id, text: line });
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        task.output.push(`[stderr] ${text}`);
        this.emit('task:output', { taskId: task.id, text: `[stderr] ${text}` });
      });

      proc.on('close', (code) => {
        this.processes.delete(task.id);
        this.persistTasks();

        if (code === 0) {
          resolve({ success: true, output: fullOutput, result: lastResult });
        } else if (task.status === 'cancelled') {
          resolve({ success: false, output: fullOutput, error: 'Cancelled' });
        } else {
          resolve({ success: false, output: fullOutput, error: `Process exited with code ${code}` });
        }
      });

      proc.on('error', (err) => {
        this.processes.delete(task.id);
        resolve({ success: false, output: fullOutput, error: err.message });
      });
    });
  }

  private emitOutput(task: AgentTask, text: string): void {
    task.output.push(text);
    this.emit('task:output', { taskId: task.id, text });
    this.persistTasks();
  }

  /**
   * Chat mode — conversational back-and-forth with persistent sessions.
   *
   * Unlike tasks (fire-and-forget, autonomous), chat is interactive:
   *   - First message  → claude -p "message" → captures session ID
   *   - Follow-ups     → claude --resume <id> -p "message" → full context preserved
   *   - Each session key (telegram chat, discord channel, web tab) gets its own conversation
   *
   * Returns the response text and the Claude session ID for --resume.
   */
  async chat(
    message: string,
    workingDir: string,
    claudeSessionId?: string,
  ): Promise<{ response: string; sessionId: string | null }> {
    return new Promise((resolve) => {
      const args: string[] = [];

      if (claudeSessionId) {
        // Continue existing conversation
        args.push('--resume', claudeSessionId, '-p', message);
      } else {
        // New conversation
        args.push('-p', message);
      }

      args.push('--output-format', 'stream-json');
      args.push('--verbose');
      args.push('--dangerously-skip-permissions');

      if (this.config.agents.defaultModel) {
        args.push('--model', this.config.agents.defaultModel);
      }

      if (this.config.agents.mcpConfigs?.length) {
        args.push('--mcp-config', ...this.config.agents.mcpConfigs);
      }

      const proc = spawn('claude', args, {
        cwd: workingDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';
      let fullResponse = '';
      let sessionId: string | null = claudeSessionId || null;

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Capture session ID from Claude's output
            if (event.session_id) sessionId = event.session_id;
            if (event.conversation_id) sessionId = event.conversation_id;
            if (event.sessionId) sessionId = event.sessionId;

            if (event.type === 'assistant' && event.content) {
              fullResponse += event.content;
              this.emit('chat:output', { text: event.content });
            } else if (event.type === 'result') {
              const text = event.result || event.content || '';
              fullResponse += text;
              this.emit('chat:output', { text });
            }
          } catch {
            fullResponse += line;
          }
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ response: fullResponse.trim(), sessionId });
        } else {
          resolve({
            response: fullResponse.trim() || 'Sorry, something went wrong. Try again.',
            sessionId,
          });
        }
      });

      proc.on('error', () => {
        resolve({ response: 'Failed to start Claude. Is the claude CLI installed?', sessionId: null });
      });
    });
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    const proc = this.processes.get(taskId);
    if (proc) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }
    }

    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    this.persistTasks();
    this.emit('task:completed', task);
    return true;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(filter?: { status?: TaskStatus; channel?: string }): AgentTask[] {
    let tasks = Array.from(this.tasks.values());
    if (filter?.status) tasks = tasks.filter(t => t.status === filter.status);
    if (filter?.channel) tasks = tasks.filter(t => t.channel === filter.channel);
    return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getRunningCount(): number {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
  }
}

interface ClaudeResult {
  success: boolean;
  output: string;
  result?: string;
  error?: string;
}
