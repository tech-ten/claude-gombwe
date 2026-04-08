import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * OpenAI-compatible API proxy → claude -p (your Max subscription).
 *
 * How it works:
 *   - Any OpenAI-compatible client sends the full message history
 *     with every request — that's how the OpenAI API works (stateless).
 *   - We convert the full messages array into a well-structured prompt.
 *   - Each request is a fresh `claude -p` call with the full context.
 *   - Model names are mapped to Claude models automatically.
 *   - If a model fails, we retry with fallback models.
 *   - Tool/function definitions are converted to prompt instructions.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: object };
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  tool_choice?: string | object;
}

const MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5',
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5',
  'claude-via-subscription': 'claude-sonnet-4-6',
  'default': 'claude-sonnet-4-6',
  'gpt-4': 'claude-opus-4-6',
  'gpt-4o': 'claude-sonnet-4-6',
  'gpt-4o-mini': 'claude-haiku-4-5',
  'gpt-3.5-turbo': 'claude-haiku-4-5',
};

const FALLBACK_ORDER = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'];

export function createProxyServer(port: number = 18791) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4-6', object: 'model', created: Date.now(), owned_by: 'gombwe' },
        { id: 'claude-sonnet-4-6', object: 'model', created: Date.now(), owned_by: 'gombwe' },
        { id: 'claude-haiku-4-5', object: 'model', created: Date.now(), owned_by: 'gombwe' },
        { id: 'claude-via-subscription', object: 'model', created: Date.now(), owned_by: 'gombwe' },
      ],
    });
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as ChatCompletionRequest;
    const { messages, stream = false, tools } = body;

    if (!messages || messages.length === 0) {
      res.status(400).json({ error: { message: 'messages is required' } });
      return;
    }

    const requestedModel = body.model || 'claude-via-subscription';
    const claudeModel = MODEL_MAP[requestedModel] || MODEL_MAP['default'];

    // Convert the full OpenAI messages array → single prompt for claude -p
    const prompt = buildPrompt(messages, tools);

    if (stream) {
      await handleStreaming(res, prompt, claudeModel, requestedModel);
    } else {
      await handleNonStreaming(res, prompt, claudeModel, requestedModel);
    }
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      proxy: 'claude-gombwe',
      backend: 'claude -p (Max subscription)',
      models: ['opus', 'sonnet', 'haiku'],
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { message: 'Not supported' } });
  });

  const server = createServer(app);

  return {
    start: () => new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        console.log(`[proxy] API proxy on http://127.0.0.1:${port}/v1`);
        console.log(`[proxy] Stateless — full context sent each call (matches OpenAI API behavior)`);
        console.log(`[proxy] Models: opus, sonnet (default), haiku — with auto-fallback`);
        resolve();
      });
    }),
    stop: () => server.close(),
  };
}

/**
 * Convert OpenAI messages array + tool definitions → single prompt string.
 *
 * This preserves the full conversation structure. Each role is clearly
 * labeled so Claude understands the multi-turn context.
 */
function buildPrompt(messages: ChatMessage[], tools?: ToolDef[]): string {
  const parts: string[] = [];

  // Tool definitions at the top
  if (tools && tools.length > 0) {
    parts.push('# Available Tools');
    parts.push('When you need to use a tool, respond ONLY with a JSON block:');
    parts.push('```json');
    parts.push('{"tool_calls": [{"id": "call_xxx", "type": "function", "function": {"name": "tool_name", "arguments": "{...}"}}]}');
    parts.push('```');
    parts.push('');
    for (const tool of tools) {
      parts.push(`## ${tool.function.name}`);
      if (tool.function.description) parts.push(tool.function.description);
      if (tool.function.parameters) {
        parts.push(`Parameters: ${JSON.stringify(tool.function.parameters)}`);
      }
      parts.push('');
    }
    parts.push('---');
    parts.push('');
  }

  // Messages — each clearly labeled
  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // System messages go at the top as instructions
        parts.push(`[SYSTEM INSTRUCTIONS]\n${msg.content}\n`);
        break;

      case 'user':
        parts.push(`[USER]\n${msg.content}\n`);
        break;

      case 'assistant':
        if (msg.content) {
          parts.push(`[ASSISTANT]\n${msg.content}\n`);
        }
        // If the assistant made tool calls, show them
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            parts.push(`[ASSISTANT TOOL CALL] ${tc.function.name}(${tc.function.arguments})\n`);
          }
        }
        break;

      case 'tool':
        parts.push(`[TOOL RESULT: ${msg.name || 'unknown'}]\n${msg.content}\n`);
        break;
    }
  }

  // Final instruction — make sure Claude responds as the assistant
  parts.push('[ASSISTANT]');

  return parts.join('\n');
}

async function handleNonStreaming(
  res: Response, prompt: string, model: string, requestedModel: string,
): Promise<void> {
  const modelsToTry = [model, ...FALLBACK_ORDER.filter(m => m !== model)];

  for (let i = 0; i < modelsToTry.length; i++) {
    const tryModel = modelsToTry[i];
    try {
      const output = await runClaude(prompt, tryModel);

      res.json({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: output },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[proxy] ${tryModel} failed: ${error}`);
      if (i === modelsToTry.length - 1) {
        res.status(500).json({ error: { message: `All models failed. Last: ${error}` } });
      }
      // Otherwise try next model
    }
  }
}

async function handleStreaming(
  res: Response, prompt: string, model: string, requestedModel: string,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const id = `chatcmpl-${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);

  // Role chunk (OpenAI sends this first)
  res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: ts, model: requestedModel,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);

  const proc = spawn('claude', [
    '-p', prompt, '--model', model, '--output-format', 'stream-json',
  ], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let text = '';
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.content) text = event.content;
        else if (event.type === 'result') text = event.result || event.content || '';
      } catch {
        text = line;
      }

      if (text) {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created: ts, model: requestedModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`);
      }
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[proxy] stderr: ${chunk.toString().trim()}`);
  });

  proc.on('close', () => {
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created: ts, model: requestedModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  proc.on('error', (err) => {
    console.error(`[proxy] error: ${err.message}`);
    res.end();
  });

  res.on('close', () => {
    if (!proc.killed) proc.kill();
  });
}

function runClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', prompt, '--model', model, '--output-format', 'text',
    ], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `claude exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}
