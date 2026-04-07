import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GombweConfig, WSEvent, IncomingMessage, ChannelAdapter } from './types.js';
import { saveConfig } from './config.js';
import { AgentRuntime } from './agent.js';
import { SessionManager } from './session.js';
import { SkillLoader } from './skills.js';
import { Scheduler } from './scheduler.js';
import { TriggerEngine } from './triggers.js';
import { WorkflowEngine } from './workflows.js';
import { WebChannel } from './channels/web.js';
import { TelegramChannel } from './channels/telegram.js';
import { DiscordChannel } from './channels/discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Gateway {
  private app;
  private server;
  private wss: WebSocketServer;
  private config: GombweConfig;
  private agent: AgentRuntime;
  private sessions: SessionManager;
  private skills: SkillLoader;
  private scheduler: Scheduler;
  private channels: Map<string, ChannelAdapter> = new Map();
  private wsClients: Set<WebSocket> = new Set();
  private triggers: TriggerEngine;
  private workflows: WorkflowEngine;

  constructor(config: GombweConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.agent = new AgentRuntime(config);
    this.sessions = new SessionManager(config);
    this.skills = new SkillLoader(config.skillsDirs);
    this.scheduler = new Scheduler(config, (job) => {
      this.agent.runTask(job.prompt, job.channel, job.sessionKey);
    });

    // Notify function — sends a message to specified channels.
    // Supports:
    //   "telegram"           → send to Telegram
    //   "discord"            → send to first Discord channel
    //   "discord:#alerts"    → send to Discord #alerts channel
    //   "web"                → send to web dashboard
    const notifyFn = (targets: string[], message: string) => {
      for (const target of targets) {
        if (target.startsWith('discord:#')) {
          // Route to specific Discord channel
          const discord = this.channels.get('discord');
          discord?.send(target.replace('discord:', ''), message);
        } else {
          const channel = this.channels.get(target);
          if (channel) {
            channel.send(`notify:${target}`, message);
          }
        }
      }
      // Always broadcast to web dashboard
      this.broadcast({
        type: 'session:message',
        data: { sessionKey: 'triggers', message, channel: 'system' },
        timestamp: new Date().toISOString(),
      });
    };

    this.triggers = new TriggerEngine(config, this.agent, notifyFn);
    this.workflows = new WorkflowEngine(config, this.agent, notifyFn);

    this.setupAgentEvents();
    this.setupWebSocket();
    this.setupRoutes();
    this.setupChannels();
  }

  private setupAgentEvents(): void {
    for (const event of ['task:created', 'task:started', 'task:completed', 'task:failed'] as const) {
      this.agent.on(event, (data) => {
        this.broadcast({ type: event, data, timestamp: new Date().toISOString() });

        // Send response back to originating channel
        if (event === 'task:completed' || event === 'task:failed') {
          const task = data;
          const channel = this.channels.get(task.channel);
          if (channel) {
            const output = task.output.join('\n').slice(-4000); // Last 4k chars
            const status = event === 'task:completed' ? 'completed' : `failed: ${task.error}`;
            channel.send(task.sessionKey, `**Task ${status}**\n\n${output}`);
          }

          this.sessions.addEntry(task.sessionKey, {
            role: 'assistant',
            content: task.output.join('\n'),
            timestamp: new Date().toISOString(),
            channel: task.channel,
          });
        }
      });
    }

    this.agent.on('task:output', (data) => {
      this.broadcast({ type: 'task:output', data, timestamp: new Date().toISOString() });
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.wsClients.add(ws);

      ws.on('message', async (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'chat') {
            const webChannel = this.channels.get('web') as WebChannel | undefined;
            const handler = webChannel?.getHandler();
            if (handler) {
              await handler({
                channel: 'web',
                sessionKey: msg.sessionKey || `web:${Date.now()}`,
                text: msg.text,
                sender: 'web-user',
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch {}
      });

      ws.on('close', () => this.wsClients.delete(ws));
    });
  }

  private broadcast(event: WSEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private setupChannels(): void {
    // Web channel (always enabled)
    const webChannel = new WebChannel();
    webChannel.setSendFn((sessionKey, message) => {
      this.broadcast({
        type: 'session:message',
        data: { sessionKey, message, channel: 'web' },
        timestamp: new Date().toISOString(),
      });
    });
    this.channels.set('web', webChannel);

    // Telegram
    if (this.config.channels.telegram?.botToken) {
      const tg = new TelegramChannel(this.config.channels.telegram.botToken);
      this.channels.set('telegram', tg);
    }

    // Discord
    if (this.config.channels.discord?.botToken) {
      const dc = new DiscordChannel(this.config.channels.discord.botToken);
      this.channels.set('discord', dc);
    }

    // Wire up message handling for all channels
    const messageHandler = async (msg: IncomingMessage) => {
      const session = this.sessions.getOrCreate(msg.sessionKey, msg.channel);
      this.sessions.addEntry(msg.sessionKey, {
        role: 'user',
        content: msg.text,
        timestamp: msg.timestamp,
        channel: msg.channel,
      });

      const channel = this.channels.get(msg.channel);

      // --- All commands use / prefix ---
      if (msg.text.startsWith('/')) {
        const [cmd, ...rest] = msg.text.slice(1).split(' ');
        const handled = await this.handleCommand(cmd, rest, msg, channel);
        if (handled) return;
      }

      // --- Task mode (if session is set to task mode) ---
      if (session.mode === 'task') {
        const skillsPrompt = this.skills.buildSkillsPrompt();
        const fullPrompt = skillsPrompt ? `${skillsPrompt}\n\n${msg.text}` : msg.text;
        await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey);
        return;
      }

      // --- Chat mode (default): conversational with --resume ---
      const claudeSessionId = this.sessions.getClaudeSessionId(msg.sessionKey);

      const result = await this.agent.chat(
        msg.text,
        this.config.agents.workingDir,
        claudeSessionId || undefined,
      );

      // Save the Claude session ID so next message resumes the conversation
      if (result.sessionId) {
        this.sessions.setClaudeSessionId(msg.sessionKey, result.sessionId);
      }

      // Record and send the response
      this.sessions.addEntry(msg.sessionKey, {
        role: 'assistant',
        content: result.response,
        timestamp: new Date().toISOString(),
        channel: msg.channel,
      });

      // Send response back through the originating channel
      channel?.send(msg.sessionKey, result.response);

      // Broadcast to web dashboard so all channels are visible there
      if (msg.channel !== 'web') {
        this.broadcast({
          type: 'session:message',
          data: { sessionKey: msg.sessionKey, message: result.response, channel: msg.channel },
          timestamp: new Date().toISOString(),
        });
      }
    };

    for (const channel of this.channels.values()) {
      channel.onMessage(messageHandler);
    }
  }

  private async handleCommand(
    cmd: string,
    args: string[],
    msg: IncomingMessage,
    channel?: ChannelAdapter,
  ): Promise<boolean> {
    const reply = (text: string) => channel?.send(msg.sessionKey, text);

    switch (cmd) {
      case 'help':
        await reply(
          `**Gombwe Commands:**\n` +
          `Just type normally → chat mode (remembers conversation)\n` +
          `Start with task:/build:/fix: → autonomous task mode\n\n` +
          `/new — start a fresh conversation\n` +
          `/mode chat|task — switch default mode\n` +
          `/sessions — list your conversations\n` +
          `/tasks — list running/recent tasks\n` +
          `/cancel <id> — cancel a running task\n` +
          `/skills — list available skills\n` +
          `/model <name> — switch model (opus/sonnet/haiku)\n`
        );
        return true;

      case 'new':
        // Start a fresh conversation (clear the Claude session ID)
        this.sessions.setClaudeSessionId(msg.sessionKey, '');
        await reply('Fresh conversation started. Previous context cleared.');
        return true;

      case 'mode': {
        const mode = args[0] as 'chat' | 'task';
        if (mode !== 'chat' && mode !== 'task') {
          await reply('Usage: /mode chat or /mode task');
          return true;
        }
        this.sessions.setMode(msg.sessionKey, mode);
        await reply(`Switched to **${mode}** mode.${mode === 'task' ? ' All messages will run as autonomous tasks.' : ' Messages are conversational with memory.'}`);
        return true;
      }

      case 'sessions': {
        const sessions = this.sessions.listSessions().slice(0, 15);
        const lines = sessions.map(s => {
          const hasConversation = s.claudeSessionId ? ' (active conversation)' : '';
          return `- **${s.key}** [${s.channel}] ${s.mode} mode${hasConversation}`;
        });
        await reply(`**Sessions:**\n${lines.join('\n') || 'No sessions yet.'}`);
        return true;
      }

      case 'tasks':
      case 'queue': {
        const tasks = this.agent.listTasks().slice(0, 10);
        const summary = tasks.map(t =>
          `- [${t.status}] ${t.id.slice(0, 8)}: ${t.prompt.slice(0, 60)}`
        ).join('\n');
        await reply(`**Recent Tasks:**\n${summary || 'No tasks yet.'}`);
        return true;
      }

      case 'cancel': {
        const taskId = args[0];
        if (!taskId) { await reply('Usage: /cancel <task-id>'); return true; }
        const found = this.agent.listTasks().find(t => t.id.startsWith(taskId));
        if (found) {
          this.agent.cancelTask(found.id);
          await reply(`Cancelled task ${found.id.slice(0, 8)}`);
        } else {
          await reply('Task not found.');
        }
        return true;
      }

      case 'skills': {
        const skills = this.skills.getInvocableSkills();
        const summary = skills.map(s => `- /${s.name}: ${s.description}`).join('\n');
        await reply(`**Available Skills:**\n${summary || 'No skills loaded.'}`);
        return true;
      }

      case 'set': {
        // /set key value — configure gombwe from any channel
        const key = args[0];
        const value = args.slice(1).join(' ');
        if (!key || !value) {
          await reply('Usage: /set <key> <value>\n\nExamples:\n  /set discord.token YOUR_BOT_TOKEN\n  /set telegram.token YOUR_BOT_TOKEN\n  /set model opus');
          return true;
        }

        // Handle shorthand keys
        if (key === 'discord.token' || key === 'discord') {
          this.config.channels.discord = { botToken: value };
          saveConfig(this.config);
          await reply(`Discord bot token saved. Restart gombwe to connect.`);
          return true;
        }
        if (key === 'telegram.token' || key === 'telegram') {
          this.config.channels.telegram = { botToken: value };
          saveConfig(this.config);
          await reply(`Telegram bot token saved. Restart gombwe to connect.`);
          return true;
        }
        if (key === 'model') {
          const modelMap: Record<string, string> = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' };
          this.config.agents.defaultModel = modelMap[value] || value;
          await reply(`Model set to ${this.config.agents.defaultModel}`);
          return true;
        }

        await reply(`Unknown key: ${key}. Available: discord.token, telegram.token, model`);
        return true;
      }

      case 'model': {
        const model = args[0];
        if (!model) { await reply('Usage: /model opus|sonnet|haiku'); return true; }
        const modelMap: Record<string, string> = {
          opus: 'claude-opus-4-6',
          sonnet: 'claude-sonnet-4-6',
          haiku: 'claude-haiku-4-5',
        };
        const resolved = modelMap[model] || model;
        this.config.agents.defaultModel = resolved;
        await reply(`Model switched to **${resolved}**`);
        return true;
      }

      case 'task':
      case 'build':
      case 'create':
      case 'fix':
      case 'deploy':
      case 'refactor':
      case 'test': {
        const prompt = args.join(' ');
        if (!prompt) { await reply(`Usage: /${cmd} <what to do>`); return true; }
        const skillsPrompt = this.skills.buildSkillsPrompt();
        const fullPrompt = skillsPrompt ? `${skillsPrompt}\n\n${prompt}` : prompt;
        await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey);
        return true;
      }

      default: {
        // Check skills
        const skill = this.skills.getSkill(cmd);
        if (skill) {
          const prompt = `${skill.instructions}\n\nUser request: ${args.join(' ')}`;
          await this.agent.runTask(prompt, msg.channel, msg.sessionKey);
          return true;
        }
        return false; // Not a known command
      }
    }
  }

  private setupRoutes(): void {
    // Serve control panel UI
    this.app.use('/ui', express.static(join(__dirname, '..', 'ui')));

    // Redirect root to UI
    this.app.get('/', (_req: Request, res: Response) => {
      res.redirect('/ui');
    });

    // --- REST API ---

    // Tasks
    this.app.get('/api/tasks', (_req: Request, res: Response) => {
      const status = _req.query.status as string | undefined;
      const tasks = this.agent.listTasks(status ? { status: status as any } : undefined);
      res.json(tasks);
    });

    this.app.post('/api/tasks', (req: Request, res: Response) => {
      const { prompt, channel = 'web', sessionKey = `web:${Date.now()}`, workingDir } = req.body;
      if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
      this.agent.runTask(prompt, channel, sessionKey, workingDir).then(task => {
        res.status(201).json(task);
      }).catch(err => {
        res.status(503).json({ error: err.message });
      });
    });

    this.app.get('/api/tasks/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const task = this.agent.getTask(id);
      if (!task) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(task);
    });

    this.app.post('/api/tasks/:id/cancel', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const ok = this.agent.cancelTask(id);
      if (!ok) { res.status(404).json({ error: 'Task not found or not running' }); return; }
      res.json({ ok: true });
    });

    // Sessions
    this.app.get('/api/sessions', (_req: Request, res: Response) => {
      res.json(this.sessions.listSessions().map(s => {
        // Force-load transcript to get real count
        const full = this.sessions.getSession(s.key);
        return {
          key: s.key,
          channel: s.channel,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          messageCount: full ? full.transcript.length : 0,
        };
      }));
    });

    this.app.get('/api/sessions/:key', (req: Request, res: Response) => {
      const key = req.params.key as string;
      const session = this.sessions.getSession(key);
      if (!session) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(session);
    });

    // Skills
    this.app.get('/api/skills', (_req: Request, res: Response) => {
      res.json(this.skills.listSkills());
    });

    this.app.post('/api/skills/reload', (_req: Request, res: Response) => {
      this.skills.load();
      res.json({ count: this.skills.listSkills().length });
    });

    // Cron jobs
    this.app.get('/api/cron', (_req: Request, res: Response) => {
      res.json(this.scheduler.listJobs());
    });

    this.app.post('/api/cron', (req: Request, res: Response) => {
      const { expression, prompt, channel = 'cron', sessionKey = `cron:${Date.now()}`, timezone } = req.body;
      if (!expression || !prompt) {
        res.status(400).json({ error: 'expression and prompt are required' });
        return;
      }
      const job = this.scheduler.createJob(expression, prompt, channel, sessionKey, timezone);
      res.status(201).json(job);
    });

    this.app.delete('/api/cron/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const ok = this.scheduler.deleteJob(id);
      if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    });

    this.app.post('/api/cron/:id/toggle', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const { enabled } = req.body;
      const job = this.scheduler.toggleJob(id, enabled);
      if (!job) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(job);
    });

    // Status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      res.json({
        name: this.config.identity.name,
        uptime: process.uptime(),
        tasks: {
          running: this.agent.getRunningCount(),
          total: this.agent.listTasks().length,
        },
        channels: Array.from(this.channels.keys()),
        skills: this.skills.listSkills().length,
        cronJobs: this.scheduler.listJobs().length,
        wsClients: this.wsClients.size,
      });
    });

    // Webhook — fires matching triggers AND workflows
    this.app.post('/api/webhook/:path', async (req: Request, res: Response) => {
      const path = req.params.path as string;
      const triggers = await this.triggers.handleWebhook(path, req.body);
      const workflows = await this.workflows.handleWebhook(path, req.body);
      res.json({
        triggered: triggers.length + workflows.length,
        triggers: triggers.map(t => t.name),
        workflows: workflows.map(w => w.name),
      });
    });

    // --- Event Triggers ---
    this.app.get('/api/triggers', (_req: Request, res: Response) => {
      res.json(this.triggers.listTriggers());
    });

    this.app.post('/api/triggers', (req: Request, res: Response) => {
      const { name, source, action, pollInterval = 300, condition } = req.body;
      if (!name || !source || !action) {
        res.status(400).json({ error: 'name, source, and action are required' });
        return;
      }
      const trigger = this.triggers.createTrigger(name, source, action, pollInterval, condition);
      res.status(201).json(trigger);
    });

    this.app.delete('/api/triggers/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const ok = this.triggers.deleteTrigger(id);
      if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    });

    this.app.post('/api/triggers/:id/toggle', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const trigger = this.triggers.toggleTrigger(id, req.body.enabled);
      if (!trigger) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(trigger);
    });

    // --- Workflows ---
    this.app.get('/api/workflows', (_req: Request, res: Response) => {
      res.json(this.workflows.listWorkflows());
    });

    this.app.post('/api/workflows', (req: Request, res: Response) => {
      const { name, description = '', trigger, steps } = req.body;
      if (!name || !trigger || !steps || !steps.length) {
        res.status(400).json({ error: 'name, trigger, and steps are required' });
        return;
      }
      const workflow = this.workflows.createWorkflow(name, description, trigger, steps);
      res.status(201).json(workflow);
    });

    this.app.post('/api/workflows/:id/run', async (req: Request, res: Response) => {
      const id = req.params.id as string;
      const outputs = await this.workflows.runWorkflow(id, req.body.context);
      res.json({ outputs });
    });

    this.app.delete('/api/workflows/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const ok = this.workflows.deleteWorkflow(id);
      if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    });

    this.app.post('/api/workflows/:id/toggle', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const wf = this.workflows.toggleWorkflow(id, req.body.enabled);
      if (!wf) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(wf);
    });
  }

  async start(): Promise<void> {
    // Load skills
    this.skills.load();
    console.log(`[gombwe] Loaded ${this.skills.listSkills().length} skills`);

    // Start channels
    for (const [name, channel] of this.channels) {
      try {
        await channel.start();
      } catch (err) {
        console.error(`[gombwe] Failed to start channel ${name}:`, err);
      }
    }

    // Register skill commands with Telegram
    const telegram = this.channels.get('telegram');
    if (telegram && 'registerCommands' in telegram) {
      const skillNames = this.skills.getInvocableSkills().map(s => s.name);
      await (telegram as TelegramChannel).registerCommands(skillNames);
    }

    // Start scheduler
    this.scheduler.startAll();
    console.log(`[gombwe] Scheduled ${this.scheduler.listJobs().length} cron jobs`);

    // Start event triggers
    this.triggers.startAll();
    console.log(`[gombwe] Active triggers: ${this.triggers.listTriggers().filter(t => t.enabled).length}`);

    // Start server
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[gombwe] Gateway running at http://${this.config.host}:${this.config.port}`);
        console.log(`[gombwe] Control panel: http://${this.config.host}:${this.config.port}/ui`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.triggers.stopAll();
    this.scheduler.stopAll();
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    this.server.close();
  }
}
