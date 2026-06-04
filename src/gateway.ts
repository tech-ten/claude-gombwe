import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GombweConfig, WSEvent, IncomingMessage, ChannelAdapter } from './types.js';
import { saveConfig } from './config.js';
import { AgentRuntime } from './agent.js';
import { SessionManager } from './session.js';
import { SkillLoader, executeSkillTool } from './skills.js';
import { Scheduler } from './scheduler.js';
import { TriggerEngine } from './triggers.js';
import { WorkflowEngine } from './workflows.js';
import { networkInterfaces, homedir } from 'node:os';
import { WebChannel } from './channels/web.js';
import { TelegramChannel } from './channels/telegram.js';
import { DiscordChannel } from './channels/discord.js';
import { EeroClient } from './eero.js';
import { EeroStore } from './eero-store.js';
import { EeroScheduler } from './eero-schedules.js';
import { NextDNSClient } from './nextdns.js';
import { mikrotik } from './mikrotik-client.js';
import { getNetworkService } from './network-service.js';
import { dnsReceiver } from './dns-log-receiver.js';
import { policyScanner } from './policy-scanner.js';
import { netflowCollector } from './netflow-collector.js';
import { AgentsformSdr } from './agentsform-sdr.js';

function localMacAddresses(): string[] {
  const macs = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.mac && i.mac !== '00:00:00:00:00:00') macs.add(i.mac.toLowerCase());
    }
  }
  return Array.from(macs);
}

// Why is this device paused? Returns null if it isn't.
function computePausedReason(device: any, profile: any, schedules: any[], now: Date) {
  const devPaused = !!device?.paused;
  const profPaused = !!profile?.paused;
  if (!devPaused && !profPaused) return null;

  for (const s of schedules) {
    if (!s.enabled) continue;
    const blocked = EeroScheduler.isCurrentlyBlocked(s, now);
    if (!blocked) continue;
    if (s.target?.type === 'device' && s.target.url === device.url) {
      return { source: 'schedule', name: s.name, scope: 'device' };
    }
    if (s.target?.type === 'profile' && profile && s.target.url === profile.url) {
      return { source: 'schedule', name: s.name, scope: 'profile', profile: profile.name };
    }
  }
  if (devPaused) return { source: 'manual', scope: 'device' };
  if (profPaused) return { source: 'manual', scope: 'profile', profile: profile.name };
  return null;
}

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
  private eero: EeroClient;
  private eeroStore: EeroStore;
  private eeroScheduler: EeroScheduler;
  private nextdns: NextDNSClient;

  constructor(config: GombweConfig) {
    this.config = config;

    // Auto-register MCP servers for the agent
    const familyMcpConfig = JSON.stringify({
      mcpServers: {
        'gombwe-family': {
          command: 'node',
          args: [join(__dirname, 'mcp', 'family.js')],
          env: {
            GOMBWE_DATA_DIR: config.dataDir,
            GOMBWE_PORT: String(config.port),
          },
        },
      },
    });
    if (!config.agents.mcpConfigs) config.agents.mcpConfigs = [];
    config.agents.mcpConfigs.push(familyMcpConfig);

    this.app = express();
    this.app.use(express.json());
    // Standard HTML form posts arrive as application/x-www-form-urlencoded;
    // needed for the agentsform lead endpoint where the form has no JS.
    this.app.use(express.urlencoded({ extended: true, limit: '64kb' }));
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

    this.eero = new EeroClient(config.dataDir);
    this.eeroStore = new EeroStore(config.dataDir, this.eero, (event) => {
      this.broadcast({ type: `eero:${event.type}` as any, data: event.data, timestamp: event.time });
    });
    this.eeroScheduler = new EeroScheduler(config.dataDir, this.eero, this.eeroStore);
    this.nextdns = new NextDNSClient(config.dataDir);

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

          // On successful grocery order: move grocery items to pantry
          if (event === 'task:completed' && task.prompt?.toLowerCase().includes('grocery-order')) {
            const output = task.output.join('\n');
            if (output.includes('ORDER CONFIRMED') || output.includes('order placed') || output.includes('Groceries are on their way')) {
              try {
                const family = this.loadFamilyData();
                const groceryItems = (family.groceryList || []).map((i: any) => i.name);
                const nonFoodItems = (family.nonFoodList || []).map((i: any) => i.name);
                for (const name of groceryItems) {
                  if (!family.pantry.some((p: string) => p.toLowerCase() === name.toLowerCase())) {
                    family.pantry.push(name);
                  }
                }
                family.groceryList = [];
                family.nonFoodList = [];
                family.lastOrdered = new Date().toISOString();
                this.logFamilyAction(family, 'gombwe', 'order completed',
                  `${groceryItems.length + nonFoodItems.length} items moved to pantry (${task.channel})`);
                this.saveFamilyData(family);
              } catch (err: any) {
                console.error(`[gateway] post-order cleanup failed: ${err.message}`);
              }
            }
          }
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
        } catch (err: any) {
          console.error(`[gateway] WebSocket message error: ${err.message}`);
        }
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

  /** Send a one-shot alert through every configured channel + the web dashboard.
   *  Used by background scripts (grocery-buy, scanners) to surface failures
   *  to the user wherever they happen to be — Discord, Telegram, web. */
  public notify(message: string, targets?: string[]): { sent_to: string[] } {
    const sent: string[] = [];
    const list = targets && targets.length ? targets : [...this.channels.keys()];
    for (const target of list) {
      if (target.startsWith('discord:#')) {
        const discord = this.channels.get('discord');
        if (discord) {
          discord.send(target.replace('discord:', ''), message);
          sent.push(target);
        }
      } else {
        const channel = this.channels.get(target);
        if (channel) {
          channel.send(`notify:${target}`, message);
          sent.push(target);
        }
      }
    }
    this.broadcast({
      type: 'session:message' as any,
      data: { sessionKey: 'system', message, channel: 'system' },
      timestamp: new Date().toISOString(),
    });
    return { sent_to: sent };
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
    for (const channel of this.channels.values()) {
      channel.onMessage((msg) => this.handleIncoming(msg));
    }
  }

  /** Resolve a path: expand ~, resolve relative paths against $HOME. */
  private expandPath(p: string): string {
    let out = p.trim();
    if (out.startsWith('~/') || out === '~') {
      out = out.replace(/^~/, process.env.HOME || '');
    }
    if (!isAbsolute(out)) {
      out = resolvePath(process.env.HOME || process.cwd(), out);
    }
    return out;
  }

  /** Validate an expanded path is an existing directory. */
  private validateDir(path: string): { ok: true } | { ok: false; reason: string } {
    if (!existsSync(path)) return { ok: false, reason: `path does not exist: ${path}` };
    if (!statSync(path).isDirectory()) return { ok: false, reason: `path is not a directory: ${path}` };
    return { ok: true };
  }

  /** Determine the cwd to use for this message: one-shot override → session → config default. */
  private resolveWorkingDir(msg: IncomingMessage): string {
    return (
      msg.workingDirOverride ||
      this.sessions.getWorkingDir(msg.sessionKey) ||
      this.config.agents.workingDir
    );
  }

  /**
   * Main per-message dispatcher. Extracted from setupChannels() so that
   * `/in <path> <text>` can re-dispatch with a one-shot cwd override.
   * `opts.suppressLog` is set when re-dispatching, so the inner call
   * doesn't double-record the user message in the transcript.
   */
  private async handleIncoming(
    msg: IncomingMessage,
    opts: { suppressLog?: boolean } = {},
  ): Promise<void> {
    const session = this.sessions.getOrCreate(msg.sessionKey, msg.channel);
    if (!opts.suppressLog) {
      this.sessions.addEntry(msg.sessionKey, {
        role: 'user',
        content: msg.text,
        timestamp: msg.timestamp,
        channel: msg.channel,
      });
    }

    const channel = this.channels.get(msg.channel);
    const workingDir = this.resolveWorkingDir(msg);

    // --- All commands use / prefix ---
    const trimmedText = msg.text.trim().replace(/\s+/g, ' ');
    if (trimmedText.startsWith('/')) {
      const [cmd, ...rest] = trimmedText.slice(1).split(' ');
      const handled = await this.handleCommand(cmd.toLowerCase(), rest, msg, channel);
      if (handled) return;
    }

    // --- Natural language family intent detection ---
    const familyIntent = this.detectFamilyIntent(trimmedText);
    if (familyIntent) {
      const handled = await this.handleCommand(familyIntent.cmd, familyIntent.args, msg, channel);
      if (handled) return;
    }

    // --- Task mode (if session is set to task mode) ---
    if (session.mode === 'task') {
      const skillsPrompt = this.skills.buildSkillsPrompt();
      const fullPrompt = skillsPrompt ? `${skillsPrompt}\n\n${msg.text}` : msg.text;
      await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey, workingDir);
      return;
    }

    // --- Chat mode (default): conversational with --resume ---
    const claudeSessionId = this.sessions.getClaudeSessionId(msg.sessionKey);

    // Skills context for first message only (MCP handles family tools natively)
    let chatMessage = msg.text;
    if (!claudeSessionId) {
      const skillsCtx = this.skills.buildSkillsPrompt();
      if (skillsCtx) chatMessage = `${skillsCtx}\n\n---\n\nUser message: ${msg.text}`;
    }

    let result = await this.agent.chat(chatMessage, workingDir, claudeSessionId || undefined);

    // Resume failed (session gone server-side or locally). Retry fresh with
    // verbatim replay of recent turns so the new session has continuity.
    // Verbatim (not summarised) because Discord chat is jumpy/random — there
    // are no themes to compress, and prompt caching favours stable prefixes.
    if (!result.ok && claudeSessionId) {
      const skillsCtx = this.skills.buildSkillsPrompt();
      // session.transcript already includes the just-added current user msg
      // (appended above), so drop the last entry before slicing.
      const history = session.transcript.slice(0, -1);
      const recent = history.slice(-10).filter(t => t.role === 'user' || t.role === 'assistant');
      const replay = recent.length
        ? 'Previous conversation (resumed after session loss):\n' +
          recent.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n') +
          '\n\n---\n\n'
        : '';
      const retryMessage =
        (skillsCtx ? `${skillsCtx}\n\n---\n\n` : '') +
        replay +
        `Current message: ${msg.text}`;
      console.warn(
        `[gateway] resume failed for ${msg.sessionKey} (stale claudeSessionId=${claudeSessionId}); ` +
        `retrying fresh with ${recent.length} turns of replayed context. ` +
        `cause=${result.error || 'unknown'}`,
      );
      result = await this.agent.chat(retryMessage, workingDir, undefined);
      if (result.ok) {
        console.log(
          `[gateway] resume retry succeeded for ${msg.sessionKey}: ` +
          `new claudeSessionId=${result.sessionId}, replayed=${recent.length} turns`,
        );
      } else {
        console.error(
          `[gateway] resume retry ALSO FAILED for ${msg.sessionKey}: ` +
          `cause=${result.error || 'unknown'}`,
        );
      }
    }

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
  }

  private async handleCommand(
    cmd: string,
    args: string[],
    msg: IncomingMessage,
    channel?: ChannelAdapter,
  ): Promise<boolean> {
    const reply = (text: string) => channel?.send(msg.sessionKey, text);
    const workingDir = this.resolveWorkingDir(msg);

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
          `/model <name> — switch model (opus/sonnet/haiku)\n` +
          `/pwd — show current working directory for this session\n` +
          `/cd <path> — set working directory for this session (alone to reset)\n` +
          `/in <path> <msg> — run one message in <path> without changing the session default\n\n` +
          `**Family:**\n` +
          `Just say it naturally — "add chicken curry to Wednesday dinner", "we need milk", "order the groceries"\n\n` +
          `Or use commands:\n` +
          `/meals — view weekly plan, grocery list, pantry\n` +
          `/dinner <day> <meal> — e.g. /dinner wed Chicken curry\n` +
          `/breakfast <day> <meal> — e.g. /breakfast sat Pancakes\n` +
          `/lunch <day> <meal> — e.g. /lunch thu Caesar salad\n` +
          `/list — view shopping list · /list milk, eggs — add items\n` +
          `/buy — order everything on the list\n` +
          `/buy <items> — order specific items (e.g. /buy hair remover)\n` +
          `/family add <name> <adult|child> [dietary] — add a family member\n` +
          `/family remove <name> — remove a family member\n` +
          `/family — view family members\n`
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

      case 'pwd': {
        const override = this.sessions.getWorkingDir(msg.sessionKey);
        const effective = override || this.config.agents.workingDir;
        await reply(
          `Working directory: \`${effective}\`` +
          (override ? '  _(set via /cd; /cd alone to reset)_' : '  _(default from config; /cd <path> to override)_'),
        );
        return true;
      }

      case 'cd': {
        if (args.length === 0) {
          this.sessions.setWorkingDir(msg.sessionKey, undefined);
          await reply(`Working directory reset to default: \`${this.config.agents.workingDir}\``);
          return true;
        }
        // Join args so quoted paths-with-spaces work too (e.g. /cd ~/code/Metcash/Data Engineering)
        const raw = args.join(' ');
        const expanded = this.expandPath(raw);
        const v = this.validateDir(expanded);
        if (!v.ok) { await reply(`/cd failed: ${v.reason}`); return true; }
        this.sessions.setWorkingDir(msg.sessionKey, expanded);
        await reply(`Working directory set to \`${expanded}\` for this session. (Use /cd alone to reset, /pwd to check.)`);
        return true;
      }

      case 'in': {
        if (args.length < 2) {
          await reply('Usage: /in <path> <message>  — runs one message in <path> without changing your session default');
          return true;
        }
        const pathArg = args[0];
        const rest = args.slice(1).join(' ');
        const expanded = this.expandPath(pathArg);
        const v = this.validateDir(expanded);
        if (!v.ok) { await reply(`/in failed: ${v.reason}`); return true; }
        // Re-dispatch the inner message with a one-shot cwd override.
        // suppressLog avoids double-recording — the original /in <...> was already logged.
        await this.handleIncoming(
          { ...msg, text: rest, workingDirOverride: expanded },
          { suppressLog: true },
        );
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
        let found;
        if (taskId) {
          found = this.agent.listTasks().find(t => t.id.startsWith(taskId));
        } else {
          // No ID given — cancel the most recent running task
          const running = this.agent.listTasks({ status: 'running' });
          found = running[0]; // listTasks returns newest first
        }
        if (found) {
          this.agent.cancelTask(found.id);
          await reply(`Cancelled task ${found.id.slice(0, 8)} — ${found.prompt.slice(0, 50)}`);
        } else {
          await reply('No running tasks to cancel.');
        }
        return true;
      }

      case 'skills': {
        const skills = this.skills.getInvocableSkills();
        const summary = skills.map(s => `- /${s.name}: ${s.description}`).join('\n');
        await reply(`**Available Skills:**\n${summary || 'No skills loaded.'}`);
        return true;
      }

      case 'job': {
        // /job /morning-briefing --schedule "0 8 * * *"
        // Parse: everything before --schedule is the prompt, after is the cron expression
        // Handle multi-line messages, smart quotes, double spaces
        const fullArgs = args.join(' ').replace(/\s+/g, ' ').replace(/[\u201C\u201D\u2018\u2019]/g, '"');
        const scheduleMatch = fullArgs.match(/--schedule\s+["']?([^"'\n]+)["']?/);
        const prompt = fullArgs.replace(/--schedule\s+["']?[^"'\n]+["']?/, '').trim();

        if (!prompt || !scheduleMatch) {
          await reply(
            '**Usage:** /job <prompt> --schedule "<cron>"\n\n' +
            '**Examples:**\n' +
            '/job /morning-briefing --schedule "0 8 * * *"\n' +
            '/job /email-digest --schedule "*/30 * * * *"\n' +
            '/job check my GitHub --schedule "0 9 * * 1-5"\n\n' +
            '**Schedules:**\n' +
            '*/30 * * * * — every 30 minutes\n' +
            '0 8 * * * — daily at 8am\n' +
            '0 9 * * 1-5 — weekdays at 9am\n' +
            '0 9 * * 1 — every Monday at 9am'
          );
          return true;
        }

        const expression = scheduleMatch[1].trim();
        const job = this.scheduler.createJob(expression, prompt, msg.channel, `cron:${Date.now()}`);
        await reply(`**Job scheduled**\nSchedule: ${expression}\nPrompt: ${prompt}\nNext run: ${job.nextRun || 'calculating...'}`);
        return true;
      }

      case 'jobs': {
        const jobs = this.scheduler.listJobs();
        if (jobs.length === 0) {
          await reply('No scheduled jobs. Create one with:\n/job /morning-briefing --schedule "0 8 * * *"');
          return true;
        }
        const lines = jobs.map(j => {
          const status = j.enabled ? 'active' : 'paused';
          return `- [${status}] **${j.expression}** — ${j.prompt.slice(0, 50)}`;
        });
        await reply(`**Scheduled Jobs:**\n${lines.join('\n')}`);
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
        await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey, workingDir);
        return true;
      }

      // ── Family commands ──────────────────────────────────────
      // /dinner wed Chicken curry — slot is the command, day + name
      // /breakfast sat Pancakes
      // /lunch thu Caesar salad
      case 'breakfast':
      case 'lunch':
      case 'dinner': {
        const mealSlot = cmd; // breakfast, lunch, or dinner
        if (args.length < 2) {
          await reply(
            `**Usage:** /${mealSlot} <day> <meal name>\n\n` +
            `**Examples:**\n` +
            `/${mealSlot} wed Chicken curry\n` +
            `/${mealSlot} friday Fish and chips\n` +
            `/${mealSlot} today Leftovers\n\n` +
            `**Days:** today, tomorrow, mon, tue, wed, thu, fri, sat, sun\n` +
            `(or full names: monday, tuesday, etc.)`
          );
          return true;
        }

        const dayArg = args[0].toLowerCase();
        const mealName = args.slice(1).join(' ');
        const dk = this.resolveDay(dayArg);

        if (!dk) {
          await reply(`I don't recognise "${args[0]}" as a day.\nTry: today, tomorrow, mon, tue, wed, thu, fri, sat, sun`);
          return true;
        }

        const family = this.loadFamilyData();
        if (!family.meals) family.meals = {};
        if (!family.meals[dk]) family.meals[dk] = {};
        family.meals[dk][mealSlot] = mealName;
        this.logFamilyAction(family, msg.sender || 'user', 'meal added', `${mealSlot} on ${dk}: ${mealName}`);
        this.saveFamilyData(family);

        const dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dk + 'T00:00:00').getDay()];
        await reply(`Got it — **${mealSlot}** ${dayLabel}: ${mealName}`);

        // Extract ingredients and add to grocery list
        try {
          const ingRes = await fetch(`http://127.0.0.1:${this.config.port}/api/family/ingredients`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meal: mealName, pantry: family.pantry || [], existing: (family.groceryList || []).map((i: any) => i.name) }),
          });
          const ingData = await ingRes.json();
          if (ingData.ingredients?.length > 0) {
            // Re-read family data (may have changed) and add ingredients
            const updated = this.loadFamilyData();
            if (!updated.groceryList) updated.groceryList = [];
            for (const name of ingData.ingredients) {
              const exists = updated.groceryList.some((i: any) => i.name.toLowerCase() === name.toLowerCase());
              if (!exists) {
                updated.groceryList.push({ name, checked: false, source: 'auto', meals: [mealName.toLowerCase()] });
              }
            }
            this.logFamilyAction(updated, 'gombwe', 'ingredients added', `${ingData.ingredients.length} items for ${mealName}`);
            this.saveFamilyData(updated);
            await reply(`Added to shopping list: ${ingData.ingredients.join(', ')}`);
          }
        } catch (err: any) {
          console.error(`[gateway] ingredient extraction failed for "${mealName}": ${err.message}`);
          await reply(`Meal added but ingredient extraction failed: ${err.message}`);
        }
        return true;
      }

      // /list — view grocery list. /list milk, eggs — add items
      case 'list': {
        const listArgs = args.join(' ').trim();
        const family = this.loadFamilyData();

        if (!listArgs) {
          // Show the list
          const groceries = (family.groceryList || []).filter((i: any) => !i.checked);
          const nonFood = (family.nonFoodList || []).filter((i: any) => !i.checked);
          if (groceries.length === 0 && nonFood.length === 0) {
            await reply('Shopping list is empty. Add items with `/list milk, eggs, bread`');
            return true;
          }
          let out = '**Shopping List**\n';
          if (groceries.length) out += '\n' + groceries.map((i: any) => `- ${i.name}`).join('\n');
          if (nonFood.length) out += '\n\n**Household**\n' + nonFood.map((i: any) => `- ${i.name}`).join('\n');
          await reply(out);
          return true;
        }

        // Add items — auto-sort food vs non-food
        if (!family.groceryList) family.groceryList = [];
        if (!family.nonFoodList) family.nonFoodList = [];
        const newItems = listArgs.split(',').map((s: string) => s.trim()).filter(Boolean);
        const added: string[] = [];
        for (const name of newItems) {
          const lower = name.toLowerCase();
          const exists = [...family.groceryList, ...family.nonFoodList].some((i: any) => {
            const n = i.name.toLowerCase();
            return n === lower || n.includes(lower) || lower.includes(n);
          });
          if (exists) continue;
          if (this.isNonFoodItem(lower)) {
            family.nonFoodList.push({ name, checked: false });
          } else {
            family.groceryList.push({ name, checked: false });
          }
          added.push(name);
        }
        if (added.length > 0) {
          this.logFamilyAction(family, msg.sender || 'user', 'added to list', added.join(', '));
          this.saveFamilyData(family);
          await reply(`Added: ${added.join(', ')}`);
        } else {
          await reply('Those items are already on the list.');
        }
        return true;
      }

      // /buy — buy everything on the list. /buy hair remover — buy specific things
      case 'buy': {
        const buyArgs = args.join(' ').trim();
        const family = this.loadFamilyData();
        let itemsToOrder: string[];

        if (buyArgs) {
          // Specific items — add to correct list first
          itemsToOrder = buyArgs.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (!family.groceryList) family.groceryList = [];
          if (!family.nonFoodList) family.nonFoodList = [];
          const newItems: string[] = [];
          for (const item of itemsToOrder) {
            const lower = item.toLowerCase();
            const exists = [...family.groceryList, ...family.nonFoodList].some((i: any) => {
              const n = i.name.toLowerCase();
              return n === lower || n.includes(lower) || lower.includes(n);
            });
            if (exists) continue;
            if (this.isNonFoodItem(lower)) {
              family.nonFoodList.push({ name: item, checked: false });
            } else {
              family.groceryList.push({ name: item, checked: false });
            }
            newItems.push(item);
          }
          if (newItems.length > 0) {
            this.logFamilyAction(family, msg.sender || 'user', 'added to list (buy)', newItems.join(', '));
            this.saveFamilyData(family);
          }
        } else {
          const groceries = (family.groceryList || []).map((i: any) => i.name);
          const nonFood = (family.nonFoodList || []).map((i: any) => i.name);
          itemsToOrder = [...groceries, ...nonFood];
        }

        if (itemsToOrder.length === 0) {
          await reply('Nothing to buy. Add items with `/list milk, eggs` first, or `/buy hair remover` to order directly.');
          return true;
        }

        await reply(`**Buying ${itemsToOrder.length} items:**\n${itemsToOrder.join(', ')}\n\nStarting order...`);

        const skillsPrompt = this.skills.buildSkillsPrompt();
        const buyPrompt = skillsPrompt
          ? `${skillsPrompt}\n\n/grocery-order ${itemsToOrder.join(', ')}`
          : `/grocery-order ${itemsToOrder.join(', ')}`;
        await this.agent.runTask(buyPrompt, msg.channel, msg.sessionKey, workingDir);
        return true;
      }

      // /family — view or manage family members
      case 'family': {
        const family = this.loadFamilyData();
        if (!family.members) family.members = [];
        const sub = args[0]?.toLowerCase();

        if (!sub || sub === 'list') {
          if (family.members.length === 0) {
            await reply(
              `No family members set yet.\n\n` +
              `**Add members:**\n` +
              `/family add <name> — add an adult\n` +
              `/family add <name> child — add a child\n` +
              `/family add <name> toddler — add a toddler\n` +
              `/family add <name> adult "no dairy" — with dietary notes\n\n` +
              `Family size affects ingredient quantities and recipe scaling.`
            );
            return true;
          }
          const lines = family.members.map((m: any) => {
            let line = `- **${m.name}** (${m.type || 'adult'})`;
            if (m.dietary) line += ` — ${m.dietary}`;
            return line;
          });
          await reply(`**Family** (${family.members.length} people)\n${lines.join('\n')}`);
          return true;
        }

        if (sub === 'add' && args.length >= 2) {
          const name = args[1];
          const typeArg = args[2]?.toLowerCase();
          const validTypes = ['adult', 'child', 'toddler', 'baby'];
          const type = validTypes.includes(typeArg || '') ? typeArg : 'adult';
          // Everything after name and type is dietary notes
          const dietaryStart = validTypes.includes(typeArg || '') ? 3 : 2;
          const dietary = args.slice(dietaryStart).join(' ').replace(/^["']|["']$/g, '') || '';

          const exists = family.members.some((m: any) => m.name.toLowerCase() === name.toLowerCase());
          if (exists) {
            await reply(`${name} is already in the family.`);
            return true;
          }

          const member: any = { name, type };
          if (dietary) member.dietary = dietary;
          family.members.push(member);
          this.logFamilyAction(family, msg.sender || 'user', 'member added', `${name} (${type})`);
          this.saveFamilyData(family);
          await reply(`Added **${name}** (${type})${dietary ? ` — ${dietary}` : ''}. Family size: ${family.members.length}`);
          return true;
        }

        if (sub === 'remove' && args.length >= 2) {
          const name = args[1].toLowerCase();
          const idx = family.members.findIndex((m: any) => m.name.toLowerCase() === name);
          if (idx === -1) {
            await reply(`No one called "${args[1]}" in the family.`);
            return true;
          }
          const removed = family.members.splice(idx, 1)[0];
          this.logFamilyAction(family, msg.sender || 'user', 'member removed', removed.name);
          this.saveFamilyData(family);
          await reply(`Removed **${removed.name}**. Family size: ${family.members.length}`);
          return true;
        }

        await reply(
          `**Usage:**\n` +
          `/family — view family members\n` +
          `/family add <name> [adult|child|toddler] ["dietary notes"]\n` +
          `/family remove <name>`
        );
        return true;
      }

      default: {
        // Check skills
        const skill = this.skills.getSkill(cmd);
        if (skill) {
          // Direct skills: execute tool immediately, skip Claude entirely
          if (skill.direct && skill.tools && skill.tools.length > 0) {
            const arg = args.join(' ').trim().toLowerCase();
            // Find matching tool by name, or default to first tool
            const tool = (arg && skill.tools.find(t => t.name.includes(arg))) || skill.tools[0];
            const skillDir = dirname(skill.path);
            const output = await executeSkillTool(tool, skillDir);
            await reply(output);
            this.sessions.addEntry(msg.sessionKey, {
              role: 'assistant',
              content: output,
              timestamp: new Date().toISOString(),
              channel: msg.channel,
            });
            return true;
          }
          const prompt = `${skill.instructions}\n\nUser request: ${args.join(' ')}`;
          await this.agent.runTask(prompt, msg.channel, msg.sessionKey, workingDir);
          return true;
        }
        return false; // Not a known command
      }
    }
  }

  private get familyFile(): string {
    return join(this.config.dataDir, 'family.json');
  }

  private loadFamilyData(): any {
    try { return JSON.parse(readFileSync(this.familyFile, 'utf-8')); }
    catch { return { meals: {}, groceryList: [], nonFoodList: [], pantry: [], events: [], members: [], actions: [] }; }
  }

  private saveFamilyData(data: any): void {
    writeFileSync(this.familyFile, JSON.stringify(data, null, 2));
  }

  private isNonFoodItem(name: string): boolean {
    const nonFoodKeywords = [
      'toilet paper', 'paper towel', 'tissues', 'napkins',
      'shampoo', 'conditioner', 'body wash', 'soap', 'hand wash',
      'toothpaste', 'toothbrush', 'mouthwash', 'floss', 'dental',
      'deodorant', 'razor', 'shaving', 'hair remover', 'wax strip',
      'sunscreen', 'moisturiser', 'moisturizer', 'lotion', 'cream',
      'detergent', 'laundry', 'fabric softener', 'bleach', 'stain',
      'dishwash', 'dish soap', 'sponge', 'scrub', 'cleaning', 'cleaner',
      'disinfectant', 'wipes', 'spray', 'air freshener',
      'bin bags', 'garbage bags', 'trash bags', 'cling wrap', 'foil', 'baking paper',
      'batteries', 'light bulb', 'candle',
      'nappy', 'nappies', 'diaper', 'diapers', 'baby wipes',
      'pad', 'pads', 'tampon', 'tampons', 'sanitary',
      'pet food', 'cat litter', 'dog food',
      'ziplock', 'sandwich bags', 'glad wrap',
      'insect', 'bug spray', 'fly spray', 'mosquito',
      'bandaid', 'band-aid', 'plaster', 'first aid',
      'cotton', 'cotton ball', 'cotton bud', 'q-tip',
    ];
    return nonFoodKeywords.some(kw => name.includes(kw) || kw.includes(name));
  }

  private detectFamilyIntent(text: string): { cmd: string; args: string[] } | null {
    const lower = text.toLowerCase().trim();
    const words = lower.split(/\s+/);

    // --- Meal intent (without slash prefix) ---
    // "dinner sat butter chicken", "breakfast tomorrow pancakes"
    const mealSlots = ['breakfast', 'lunch', 'dinner'];
    if (mealSlots.includes(words[0]) && words.length >= 3) {
      return { cmd: words[0], args: words.slice(1) };
    }

    return null;
  }

  private resolveDay(input: string): string | null {
    const now = new Date();
    const lower = input.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // Common aliases
    if (lower === 'today' || lower === 'tdy' || lower === 'tonite' || lower === 'tonight') {
      return this.localDateStr(now);
    }
    if (lower === 'tomorrow' || lower === 'tmrw' || lower === 'tmr' || lower === 'tomoz' || lower === 'tomo') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return this.localDateStr(d);
    }

    // YYYY-MM-DD passthrough
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

    // Canonical day names with all common abbreviations
    const days: [number, string[]][] = [
      [0, ['sun', 'sunday', 'su']],
      [1, ['mon', 'monday', 'mo']],
      [2, ['tue', 'tuesday', 'tu', 'tues']],
      [3, ['wed', 'wednesday', 'we', 'weds']],
      [4, ['thu', 'thursday', 'th', 'thur', 'thurs']],
      [5, ['fri', 'friday', 'fr']],
      [6, ['sat', 'saturday', 'sa']],
    ];

    // Exact match first
    for (const [num, aliases] of days) {
      if (aliases.includes(lower)) return this.dayOffset(now, num);
    }

    // Prefix match — "satur", "wednes", "thurs" etc
    const fullNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < fullNames.length; i++) {
      if (lower.length >= 2 && fullNames[i].startsWith(lower)) return this.dayOffset(now, i);
    }

    // Fuzzy match — handle typos like "satruday", "wendsday", "thursdya", "frieday"
    let bestMatch = -1;
    let bestDist = Infinity;
    for (let i = 0; i < fullNames.length; i++) {
      const d = this.levenshtein(lower, fullNames[i]);
      if (d < bestDist) { bestDist = d; bestMatch = i; }
    }
    // Accept if edit distance is at most 2 (or 3 for longer words)
    const maxDist = lower.length >= 7 ? 3 : 2;
    if (bestDist <= maxDist) return this.dayOffset(now, bestMatch);

    return null;
  }

  private localDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private dayOffset(now: Date, targetDay: number): string {
    const current = now.getDay();
    let diff = targetDay - current;
    if (diff < 0) diff += 7;
    const d = new Date(now);
    d.setDate(d.getDate() + diff);
    return this.localDateStr(d);
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  private logFamilyAction(data: any, actor: string, action: string, detail: string): void {
    if (!data.actions) data.actions = [];
    data.actions.unshift({ time: new Date().toISOString(), actor, action, detail });
    if (data.actions.length > 100) data.actions.length = 100;
  }

  private setupRoutes(): void {
    // Serve control panel UI
    this.app.use('/ui', express.static(join(__dirname, '..', 'ui')));

    // Redirect root to UI
    this.app.get('/', (_req: Request, res: Response) => {
      res.redirect('/ui');
    });

    // --- REST API ---

    // ── Notify (used by background scripts to alert via channels) ─
    // POST { message: string, targets?: string[] }
    // Targets default to all configured channels (discord, telegram, …).
    this.app.post('/api/notify', (req: Request, res: Response) => {
      const { message, targets } = req.body ?? {};
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message required' });
        return;
      }
      res.json(this.notify(message, Array.isArray(targets) ? targets : undefined));
    });

    // ── Agentsform lead form receiver ─────────────────────────────
    // Public POST endpoint for agentsform.ai contact forms. Plain HTML
    // form submission (application/x-www-form-urlencoded), no auth, no
    // CORS preflight. Validates honeypot + rate-limits per IP, appends
    // to leads.jsonl, fires Discord notification, redirects to /thanks.
    //
    // Tunnel: route api.agentsform.ai → localhost:18790 (no Access policy).
    const leadsFile = join(homedir(), '.claude-gombwe', 'data', 'leads.jsonl');
    const leadRateLimit = new Map<string, { count: number; resetAt: number }>();
    const LEAD_LIMIT_WINDOW_MS = 60_000;
    const LEAD_LIMIT_MAX = 5;  // 5 submissions per IP per minute

    this.app.post('/api/agentsform-lead', (req: Request, res: Response) => {
      const now = Date.now();
      const ip = (req.headers['cf-connecting-ip'] as string)
              || (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim()
              || req.socket.remoteAddress
              || 'unknown';

      // Rate limit per IP
      const rl = leadRateLimit.get(ip);
      if (rl && rl.resetAt > now) {
        if (rl.count >= LEAD_LIMIT_MAX) {
          res.status(429).type('text/plain').send('Too many submissions. Try again in a minute.');
          return;
        }
        rl.count++;
      } else {
        leadRateLimit.set(ip, { count: 1, resetAt: now + LEAD_LIMIT_WINDOW_MS });
      }

      const body = req.body ?? {};
      const honeypot = String(body._gotcha ?? '').trim();
      if (honeypot.length > 0) {
        // Bot — pretend success so they don't retry, but discard.
        res.redirect(302, 'https://agentsform.ai/thanks.html');
        return;
      }

      const name = String(body.name ?? '').trim().slice(0, 200);
      const phone = String(body.phone ?? '').trim().slice(0, 50);
      const email = String(body.email ?? '').trim().slice(0, 200);
      const message = String(body.message ?? '').trim().slice(0, 2000);
      const preferred = String(body.preferred_time ?? '').trim().slice(0, 100);
      const source = String(body.source ?? 'unknown').trim().slice(0, 100);

      if (!name || (!phone && !email)) {
        res.status(400).type('text/plain').send('Name and at least one of phone/email required.');
        return;
      }

      const record = {
        ts: new Date().toISOString(),
        ip,
        name, phone, email, message, preferred_time: preferred, source,
        user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        referer: String(req.headers['referer'] ?? '').slice(0, 300),
      };

      try {
        mkdirSync(dirname(leadsFile), { recursive: true });
        appendFileSync(leadsFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      } catch (err) {
        console.error('[agentsform-lead] write failed:', err);
        res.status(500).type('text/plain').send('Could not record lead. Please call 0401 156 266 directly.');
        return;
      }

      const summary = [
        `**New lead from agentsform.ai** (${source})`,
        `Name: ${name}`,
        phone ? `Phone: ${phone}` : null,
        email ? `Email: ${email}` : null,
        preferred ? `Preferred time: ${preferred}` : null,
        message ? `Message: ${message}` : null,
        `_(${ip})_`,
      ].filter(Boolean).join('\n');
      this.notify(summary);

      res.redirect(302, 'https://agentsform.ai/thanks.html');
    });

    // ── Network monitoring + control ─────────────────────────────
    this.app.get('/api/network/status', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await getNetworkService().status()); }
      catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
    });

    // ── Advanced subtab data: NAT, DHCP leases, firewall ──────────
    this.app.get('/api/network/nat', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await mikrotik.natRules()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // POST /api/network/nat/port-forward — adds a dstnat rule.
    // Body: { srcPort, dstAddress, dstPort, protocol: 'tcp'|'udp', comment }
    this.app.post('/api/network/nat/port-forward', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const { srcPort, dstAddress, dstPort, protocol, comment } = req.body || {};
      const sp = parseInt(String(srcPort)), dp = parseInt(String(dstPort));
      const proto = protocol === 'udp' ? 'udp' : 'tcp';
      if (!sp || sp < 1 || sp > 65535 || !dp || dp < 1 || dp > 65535) {
        res.status(400).json({ error: 'srcPort and dstPort must be 1-65535' }); return;
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(dstAddress))) {
        res.status(400).json({ error: 'dstAddress must be IPv4 dotted-quad' }); return;
      }
      try {
        const id = await mikrotik.addPortForward({ srcPort: sp, dstAddress: String(dstAddress), dstPort: dp, protocol: proto, comment: `gombwe-pf ${comment || ''}`.trim() });
        res.json({ id });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.delete('/api/network/nat/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { await mikrotik.removeNatRule(String(req.params.id)); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    this.app.get('/api/network/dhcp-leases', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await mikrotik.dhcpLeases()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // POST /api/network/dhcp-leases — body: { mac, address, comment }
    this.app.post('/api/network/dhcp-leases', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const { mac, address, comment } = req.body || {};
      if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(String(mac))) {
        res.status(400).json({ error: 'mac must be AA:BB:CC:DD:EE:FF' }); return;
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(address))) {
        res.status(400).json({ error: 'address must be IPv4 dotted-quad' }); return;
      }
      try {
        const id = await mikrotik.addStaticLease({ mac: String(mac), address: String(address), comment: `gombwe-static ${comment || ''}`.trim() });
        res.json({ id });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.delete('/api/network/dhcp-leases/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { await mikrotik.removeLease(String(req.params.id)); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // POST /api/network/dhcp-leases/:id/make-static — promote dynamic→static.
    this.app.post('/api/network/dhcp-leases/:id/make-static', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { await mikrotik.makeLeaseStatic(String(req.params.id)); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // ── Schedules (per-MAC recurring block/unblock, MikroTik-native) ──
    this.app.get('/api/network/schedules', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { list } = await import('./schedule-service.js');
        res.json(list());
      } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // POST body: type-discriminated
    //   recurring:    { type:'recurring', name, mac, days:[...], start_time:'HH:MM', end_time:'HH:MM' }
    //   pause-until:  { type:'pause-until', name, mac, pause_until:'ISO datetime' }
    this.app.post('/api/network/schedules', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const b = req.body || {};
      const type = b.type || 'recurring';
      if (!b.name || !b.mac) { res.status(400).json({ error: 'name and mac required' }); return; }
      if (type === 'recurring' && (!Array.isArray(b.days) || !b.start_time || !b.end_time)) {
        res.status(400).json({ error: 'recurring schedules require days[], start_time, end_time' }); return;
      }
      if (type === 'pause-until' && !b.pause_until) {
        res.status(400).json({ error: 'pause-until schedules require pause_until' }); return;
      }
      try {
        const { create } = await import('./schedule-service.js');
        const def = await create(b);
        res.json(def);
      } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    this.app.put('/api/network/schedules/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { update } = await import('./schedule-service.js');
        const def = await update(String(req.params.id), req.body || {});
        if (!def) { res.status(404).json({ error: 'not found' }); return; }
        res.json(def);
      } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    this.app.delete('/api/network/schedules/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { remove } = await import('./schedule-service.js');
        const ok = await remove(String(req.params.id));
        res.json({ ok });
      } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Webhook hit by router-side scheduler entries on each window open/close.
    // GET (not POST) because RouterOS /tool/fetch sends GET cleanly without
    // any JSON-quoting gymnastics in the on-event script string.
    //   GET /api/network/schedule-fired?id=<sid>&event=start|end
    // Filters by the schedule's weekday list — RouterOS scheduler can't
    // natively day-of-week filter, so we ignore fires on non-active days.
    this.app.get('/api/network/schedule-fired', async (req: Request, res: Response) => {
      const id = String(req.query.id || '').trim();
      const event = String(req.query.event || '').trim();
      if (!id || !['start', 'end'].includes(event)) {
        res.status(400).json({ error: 'id and event=start|end required' }); return;
      }
      try {
        const { getById, isActiveToday } = await import('./schedule-service.js');
        const def = getById(id);
        if (!def) { res.json({ ok: true, ignored: 'schedule not found' }); return; }
        if (!isActiveToday(def)) { res.json({ ok: true, ignored: 'not an active day' }); return; }
        getNetworkService().writeAudit({
          time: new Date().toISOString(),
          action: event === 'start' ? 'schedule-block-started' : 'schedule-block-ended',
          mac: def.mac,
          schedule_id: id,
          schedule_name: def.name,
          severity: 'info',
        });
        res.json({ ok: true, logged: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Diagnostic — show the router-side state for a schedule.
    this.app.get('/api/network/schedules/:id/inspect', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { inspect } = await import('./schedule-service.js');
        res.json(await inspect(String(req.params.id)));
      } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Raw MikroTik REST proxy — backs the Raw API subtab. Body for
    // POST/PUT/PATCH is forwarded as-is; method must be one of the
    // standard verbs. Path must start with "/" so it gets prepended
    // to the configured REST base. No write-method gates here — the
    // user explicitly invoking this knows what they're doing.
    this.app.post('/api/network/mt-raw', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const { method, path, body } = req.body || {};
      const M = String(method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(M)) {
        res.status(400).json({ error: 'method must be GET/POST/PUT/PATCH/DELETE' }); return;
      }
      if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        res.status(400).json({ error: 'path must start with /' }); return;
      }
      const started = Date.now();
      try {
        const result = await mikrotik.raw(M, path, body);
        res.json({ ok: true, ms: Date.now() - started, result });
      } catch (err) {
        res.status(500).json({ ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Firewall rules viewer.
    this.app.get('/api/network/firewall', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await mikrotik.filterRules()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Toggle / remove a firewall rule. SERVER-SIDE GATE: only rules whose
    // comment starts with "gombwe" can be touched via this API. The router
    // itself doesn't enforce this — we do. Anything else (defaults, manual
    // entries) requires WinBox/SSH to avoid accidental lockout.
    this.app.post('/api/network/firewall/:id/toggle', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const rule = await mikrotik.getFilterRule(String(req.params.id));
        if (!rule) { res.status(404).json({ error: 'rule not found' }); return; }
        if (!(rule.comment || '').startsWith('gombwe')) {
          res.status(403).json({ error: 'only gombwe-managed rules can be toggled via API' }); return;
        }
        const disabled = !!req.body?.disabled;
        await mikrotik.setRuleDisabled(String(req.params.id), disabled);
        res.json({ ok: true, disabled });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.delete('/api/network/firewall/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const rule = await mikrotik.getFilterRule(String(req.params.id));
        if (!rule) { res.json({ ok: true }); return; }   // idempotent
        if (!(rule.comment || '').startsWith('gombwe')) {
          res.status(403).json({ error: 'only gombwe-managed rules can be removed via API' }); return;
        }
        await mikrotik.removeRule(String(req.params.id));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Live interface stats — feeds the Speed subtab. Polled every few seconds
    // by the UI. interfaceStatsLive synthesises bits-per-second from byte
    // counter deltas; first call shows 0, subsequent calls show real rates.
    this.app.get('/api/network/interfaces', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await mikrotik.interfaceStatsLive()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    this.app.get('/api/network/devices', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await getNetworkService().devices()); }
      catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
    });

    this.app.post('/api/network/devices/:mac/block', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac);
      const duration = req.body?.duration_minutes ?? null;
      try {
        const result = await getNetworkService().block(mac, duration);
        res.json({ ok: true, ...result });
        this.broadcast({ type: 'network:device:update', data: { mac: mac.toUpperCase(), blocked: true, block_expires: result.blocked_until }, timestamp: new Date().toISOString() });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

    this.app.post('/api/network/devices/:mac/unblock', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac);
      try {
        await getNetworkService().unblock(mac);
        res.json({ ok: true });
        this.broadcast({ type: 'network:device:update', data: { mac: mac.toUpperCase(), blocked: false, block_expires: null }, timestamp: new Date().toISOString() });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

    this.app.post('/api/network/devices/:mac/name', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac);
      const name = (req.body?.name ?? '').toString().trim();
      getNetworkService().setAlias(mac, name);
      res.json({ ok: true });
      this.broadcast({ type: 'network:device:update', data: { mac: mac.toUpperCase(), name }, timestamp: new Date().toISOString() });
    });

    // Person-first grouping: assign a device to a person (or null to unassign → "Household devices")
    this.app.post('/api/network/devices/:mac/owner', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac);
      const ownerRaw = req.body?.owner;
      const owner = ownerRaw === null || ownerRaw === '' ? null : String(ownerRaw).trim() || null;
      getNetworkService().setOwner(mac, owner);
      res.json({ ok: true });
      this.broadcast({ type: 'network:device:update', data: { mac: mac.toUpperCase(), owner }, timestamp: new Date().toISOString() });
    });

    // Recent DNS queries, optionally filtered by client IP (e.g. ?client=192.168.88.245)
    this.app.get('/api/network/dns/recent', (req: Request, res: Response) => {
      const client = req.query.client as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 2000);
      const recent = dnsReceiver().recent(limit);
      res.json(client ? recent.filter(r => r.client_ip === client) : recent);
    });

    // Per-client DNS summary (count + top hostnames) over the in-memory ring
    this.app.get('/api/network/dns/summary', (_req: Request, res: Response) => {
      const summary = dnsReceiver().perClientSummary();
      const out: Record<string, { count: number; blocked: number; top: Array<{ hostname: string; count: number }> }> = {};
      for (const [client, agg] of Object.entries(summary)) {
        const top = [...agg.hostnames.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([hostname, count]) => ({ hostname, count }));
        out[client] = { count: agg.count, blocked: agg.blocked, top };
      }
      res.json(out);
    });

    // ── Kid list (per-device policy scoping) ─────────────────────
    // GET → who's currently on the kid list
    this.app.get('/api/network/kid-list', (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      res.json({ macs: getNetworkService().kidMacs() });
    });

    // POST /api/network/devices/:mac/kid  body: { enabled: true|false }
    this.app.post('/api/network/devices/:mac/kid', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac).toUpperCase();
      const enabled = !!req.body?.enabled;
      getNetworkService().setKid(mac, enabled);
      res.json({ ok: true, mac, enabled });
      this.broadcast({ type: 'network:device:update', data: { mac, kid: enabled }, timestamp: new Date().toISOString() });
    });

    // ── Per-device category policy ────────────────────────────────
    // GET → { blockedCategories, updatedAt }
    this.app.get('/api/network/devices/:mac/policy', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      res.json(getNetworkService().getDevicePolicy(String(req.params.mac)));
    });

    // PUT body: { categories: ["adult","gambling",...] }
    this.app.put('/api/network/devices/:mac/policy', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.params.mac).toUpperCase();
      const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
      getNetworkService().setDevicePolicy(mac, categories, 'manual');
      res.json({ ok: true, mac, ...getNetworkService().getDevicePolicy(mac) });
      this.broadcast({ type: 'network:device:update', data: { mac, policy: getNetworkService().getDevicePolicy(mac) }, timestamp: new Date().toISOString() });
    });

    // ── Policy scanner ────────────────────────────────────────────
    // GET recent policy actions (audit journal)
    this.app.get('/api/network/policy/actions', (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      res.json(getNetworkService().policyActions(500));
    });

    // Breach dossier — permanent per-device flag history (independent of banner
    // dismissal). The case file the dashboard renders + can export.
    this.app.get('/api/network/dossier', (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      res.json(getNetworkService().dossier());
    });

    // Usage dossier — per-device session/byte ledger from recorded NetFlow
    // (+ snapshot fallback). ?days=N (default 7).
    this.app.get('/api/network/usage', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '7'), 10) || 7));
      const svc = getNetworkService();
      try { res.json(await svc.nameUsageDevices(svc.usageDossier(days))); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Forensic dossier — sequenced CONCERNING sessions for one device (adult /
    // vpn / gambling / dating / ai-helper) with duration + bytes. ?mac=&days=N
    this.app.get('/api/network/forensics', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.query.mac || '').toUpperCase();
      if (!mac) { res.status(400).json({ error: 'mac required' }); return; }
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '14'), 10) || 14));
      try { res.json(getNetworkService().getDossier(mac, days)); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Per-device activity log — what this device did online, over time (DNS
    // history, categorised, risky activity flagged). ?mac=&days=N&flaggedOnly=
    this.app.get('/api/network/activity', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.query.mac || '').toUpperCase();
      if (!mac) { res.status(400).json({ error: 'mac required' }); return; }
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '7'), 10) || 7));
      const flaggedOnly = String(req.query.flaggedOnly) === 'true';
      try { res.json(getNetworkService().activityLog(mac, days, flaggedOnly)); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Live strands — every active session as an inspectable thread.
    this.app.get('/api/network/strands', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await getNetworkService().liveStrands()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });
    this.app.post('/api/network/strands/cut', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const { deviceIp, dst } = req.body || {};
      if (!deviceIp || !dst) { res.status(400).json({ error: 'deviceIp and dst required' }); return; }
      try { res.json({ ok: true, ...(await getNetworkService().cutStrand(String(deviceIp), String(dst))) }); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });
    this.app.post('/api/network/strands/reconnect', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const { deviceIp, dst } = req.body || {};
      if (!deviceIp || !dst) { res.status(400).json({ error: 'deviceIp and dst required' }); return; }
      try { res.json({ ok: true, ...(await getNetworkService().reconnectStrand(String(deviceIp), String(dst))) }); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Download the full flag record as a file (JSON or CSV) for an offline dossier.
    this.app.get('/api/network/dossier/export', (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const flags = getNetworkService().allFlags();
      if (String(req.query.format) === 'csv') {
        const cols = ['time', 'name', 'mac', 'ip', 'category', 'severity', 'hostname', 'reason'];
        const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [cols.join(','), ...flags.map(f => cols.map(c => esc(f[c])).join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="gombwe-breach-dossier.csv"');
        res.send(csv);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="gombwe-breach-dossier.json"');
        res.send(JSON.stringify(flags, null, 2));
      }
    });

    // Active alerts (MikroTik-driven). Currently: flapping-device. Returns
    // the same shape as the legacy eero alerts so the dashboard banner can
    // render both through one code path during the migration.
    this.app.get('/api/network/alerts', (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(getNetworkService().alerts()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // Debug: synthesize a DNS query event so the category-enforcer can be
    // verified end-to-end without waiting on real device traffic. Bypasses
    // the IP→MAC lookup (you pass the MAC directly). The server still goes
    // through the real enforce path: categoryFor → enforceCategoryBlock →
    // firewall rule + conntrack kill + audit log.
    //
    // POST body: { mac, hostname }
    this.app.post('/api/network/category-enforcer/test', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const mac = String(req.body?.mac || '').toUpperCase();
      const hostname = String(req.body?.hostname || '').trim();
      if (!mac || !hostname) { res.status(400).json({ error: 'mac and hostname required' }); return; }
      try {
        const { categoryFor } = await import('./blocklist-cache.js');
        const category = categoryFor(hostname);
        if (!category) { res.json({ ok: false, reason: 'hostname has no category', hostname }); return; }
        const policy = getNetworkService().getDevicePolicy(mac);
        if (!policy.blockedCategories.includes(category)) {
          res.json({ ok: false, reason: `category ${category} not in device policy`, policy: policy.blockedCategories });
          return;
        }
        const result = await getNetworkService().enforceCategoryBlock(mac, hostname, category);
        res.json({ ok: true, mac, hostname, category, ...result });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // POST → trigger a manual scan now (useful for testing, also UI button)
    this.app.post('/api/network/policy/scan', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try { res.json(await policyScanner().tick()); }
      catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // ── Network-wide blocklists (MikroTik /ip/dns/adlist) ─────────
    // Curated community sources defined in blocklist-sources.ts. The UI
    // shows them grouped by category; subscribing pushes the URL to the
    // router which then NXDOMAINs any matched hostname.
    this.app.get('/api/network/adlist', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { BLOCKLIST_SOURCES } = await import('./blocklist-sources.js');
        const subscriptions = await mikrotik.listAdlists();
        // Annotate each subscription with the matching source (if any) so the UI
        // can show "Hagezi Gambling" rather than a raw URL.
        const annotated = subscriptions.map(s => ({
          ...s,
          source: BLOCKLIST_SOURCES.find(src => src.url === s.url) || null,
        }));
        res.json({ subscriptions: annotated, sources: BLOCKLIST_SOURCES });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // POST body: { sourceId } to subscribe to a curated source, or
    //             { url, comment } for a custom URL.
    this.app.post('/api/network/adlist', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { BLOCKLIST_SOURCES, findSource } = await import('./blocklist-sources.js');
        const { sourceId, url, comment } = req.body || {};
        let targetUrl: string;
        let targetComment: string;
        if (sourceId) {
          const src = findSource(String(sourceId));
          if (!src) { res.status(400).json({ error: `unknown sourceId: ${sourceId}` }); return; }
          targetUrl = src.url;
          targetComment = `gombwe ${src.category}:${src.id}`;
        } else if (url) {
          targetUrl = String(url);
          targetComment = comment ? `gombwe custom:${comment}` : 'gombwe custom';
        } else {
          res.status(400).json({ error: 'sourceId or url required' });
          return;
        }
        // Refuse duplicates — MikroTik would happily create two identical
        // subscriptions, doubling fetch traffic without changing behaviour.
        const existing = await mikrotik.listAdlists();
        const dupe = existing.find(s => s.url === targetUrl);
        if (dupe) { res.status(409).json({ error: 'already subscribed', id: dupe['.id'] }); return; }
        const id = await mikrotik.addAdlist(targetUrl, targetComment);
        res.json({ id, url: targetUrl, sources: BLOCKLIST_SOURCES });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.delete('/api/network/adlist/:id', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        await mikrotik.removeAdlist(String(req.params.id));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Local blocklist cache (powers per-device classification) ──
    // Status: when each source was last fetched, entry count per category.
    this.app.get('/api/network/blocklist-cache/status', async (_req: Request, res: Response) => {
      try {
        const { status } = await import('./blocklist-cache.js');
        res.json(status());
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // POST → force a refresh now. Returns counts.
    this.app.post('/api/network/blocklist-cache/refresh', async (_req: Request, res: Response) => {
      try {
        const { refresh } = await import('./blocklist-cache.js');
        res.json(await refresh());
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Diagnostic — what category does the cache classify this hostname as?
    // GET /api/network/blocklist-cache/lookup?host=example.com
    this.app.get('/api/network/blocklist-cache/lookup', async (req: Request, res: Response) => {
      const host = String(req.query.host || '').trim();
      if (!host) { res.status(400).json({ error: 'host query param required' }); return; }
      try {
        const { categoryFor } = await import('./blocklist-cache.js');
        res.json({ hostname: host, category: categoryFor(host) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // POST /api/network/adlist/refresh — force MikroTik to re-fetch all subscriptions now.
    this.app.post('/api/network/adlist/refresh', async (_req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        await mikrotik.refreshAdlists();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── History (long-term browsing rollups) ──────────────────────
    // Query a date range; pre-computed rollups for past days + live-computed
    // for today. Returns one DayRollup per day in the range.
    //
    //   GET /api/network/history?from=YYYY-MM-DD&to=YYYY-MM-DD
    //                            &mac=AA:BB:CC:...   (optional, single device)
    //                            &owner=Tendai       (optional, filter by owner)
    //
    // Defaults: last 30 days.
    this.app.get('/api/network/history', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      try {
        const { buildDayRollup, readRollup } = await import('./history-rollup.js');
        const { deviceMatchesOwner } = await import('./owner-heuristic.js');

        const today = new Date().toISOString().slice(0, 10);
        const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const from   = String(req.query.from ?? defaultFrom);
        const to     = String(req.query.to   ?? today);
        const macQ   = req.query.mac   ? String(req.query.mac).toUpperCase() : null;
        const ownerQ = req.query.owner ? String(req.query.owner)             : null;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
          return;
        }

        const dates: string[] = [];
        for (let d = new Date(from); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
          dates.push(d.toISOString().slice(0, 10));
          if (dates.length > 400) break;   // hard cap
        }

        const series = [];
        for (const date of dates) {
          let day = date === today ? null : readRollup(date);
          if (!day) day = await buildDayRollup(date);

          let devices = day.devices;
          if (macQ)   devices = devices.filter(d => d.mac.toUpperCase() === macQ);
          // Owner filter: explicit assignment OR heuristic guess from device names.
          // Lets legacy rollups (where owner: null was persisted) still resolve.
          if (ownerQ) devices = devices.filter(d => deviceMatchesOwner(d, ownerQ));
          series.push({
            date: day.date,
            devices,
            total_bytes: devices.reduce((s, d) => s + d.bytes_up + d.bytes_down, 0),
            total_queries: devices.reduce((s, d) => s + d.dns_count, 0),
          });
        }

        res.json({ from, to, mac: macQ, owner: ownerQ, days: series });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Categories (app/category lookup database) ─────────────────
    // Returns every known entry grouped by category, with recent DNS-query
    // counts so the user can see which buckets are active on the network.
    this.app.get('/api/network/categories', async (_req: Request, res: Response) => {
      try {
        const { getAllEntries, CATEGORY_ORDER, categorize } = await import('./app-categories.js');
        const all = getAllEntries();

        // Last-7-days DNS query counts per category
        const dnsCounts: Record<string, number> = {};
        const dnsLogPath = (date: string) => join(homedir(), '.claude-gombwe', 'data', 'network', `dns-${date}.jsonl`);
        const today = new Date();
        for (let i = 0; i < 7; i++) {
          const d = new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10);
          const p = dnsLogPath(d);
          if (!existsSync(p)) continue;
          const text = readFileSync(p, 'utf-8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const q = JSON.parse(line);
              const { category } = categorize(q.hostname);
              dnsCounts[category] = (dnsCounts[category] ?? 0) + 1;
            } catch { /* skip */ }
          }
        }

        const byCategory: Record<string, { entries: typeof all; count_recent_7d: number }> = {};
        for (const cat of CATEGORY_ORDER) byCategory[cat] = { entries: [], count_recent_7d: dnsCounts[cat] ?? 0 };
        for (const e of all) {
          if (!byCategory[e.category]) byCategory[e.category] = { entries: [], count_recent_7d: 0 };
          byCategory[e.category].entries.push(e);
        }
        res.json({ categories: byCategory, order: CATEGORY_ORDER });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Top hostnames from the last 7 days whose category is "unknown".
    // This is the "grow the database from real traffic" surface.
    this.app.get('/api/network/categories/uncategorized', async (req: Request, res: Response) => {
      try {
        const { categorize } = await import('./app-categories.js');
        const limit = Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50);
        const days  = Math.min(30,  parseInt(String(req.query.days  ?? '7'),  10) || 7);

        const counts = new Map<string, { count: number; last_seen: string; blocked: number }>();
        const today = new Date();
        for (let i = 0; i < days; i++) {
          const d = new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10);
          const p = join(homedir(), '.claude-gombwe', 'data', 'network', `dns-${d}.jsonl`);
          if (!existsSync(p)) continue;
          const text = readFileSync(p, 'utf-8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const q = JSON.parse(line);
              if (!q.hostname) continue;
              const cat = categorize(q.hostname);
              if (cat.category !== 'unknown') continue;
              const cur = counts.get(q.hostname) ?? { count: 0, last_seen: '', blocked: 0 };
              cur.count += 1;
              if (q.ts > cur.last_seen) cur.last_seen = q.ts;
              if (q.blocked) cur.blocked += 1;
              counts.set(q.hostname, cur);
            } catch { /* skip */ }
          }
        }

        const sorted = [...counts.entries()]
          .map(([hostname, v]) => ({ hostname, ...v }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);
        res.json({ days, items: sorted });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Add or remove a user-override entry.
    //   POST { action: "add",    suffix, app, category }
    //   POST { action: "remove", suffix }
    this.app.post('/api/network/categories', async (req: Request, res: Response) => {
      try {
        const { addUserEntry, removeUserEntry, CATEGORY_ORDER } = await import('./app-categories.js');
        const { action, suffix, app, category } = req.body ?? {};
        if (!suffix || typeof suffix !== 'string') { res.status(400).json({ error: 'suffix required' }); return; }
        if (action === 'remove') {
          const ok = removeUserEntry(suffix);
          res.json({ ok, suffix });
          return;
        }
        if (action === 'add') {
          if (!app || typeof app !== 'string')      { res.status(400).json({ error: 'app required' }); return; }
          if (!category || !CATEGORY_ORDER.includes(category)) {
            res.status(400).json({ error: `category must be one of ${CATEGORY_ORDER.join(', ')}` });
            return;
          }
          const entry = addUserEntry(suffix, app, category as any);
          res.json({ ok: true, entry });
          return;
        }
        res.status(400).json({ error: 'action must be "add" or "remove"' });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Manual rollup generator (useful after backfill issues; restricted to past dates)
    this.app.post('/api/network/history/rollup/:date', async (req: Request, res: Response) => {
      if (!mikrotik.configured) { res.status(503).json({ error: 'MikroTik not configured' }); return; }
      const date = String(req.params.date ?? '');
      const today = new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return; }
      if (date >= today) { res.status(400).json({ error: 'cannot generate rollup for today (in progress)' }); return; }
      try {
        const { generateRollup } = await import('./history-rollup.js');
        const r = await generateRollup(date);
        res.json({ ok: true, date, devices: r.devices.length });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

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

    this.app.post('/api/tasks/reload', (_req: Request, res: Response) => {
      this.agent.reloadTasks();
      const tasks = this.agent.listTasks();
      res.json({ ok: true, count: tasks.length });
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
      const mem = process.memoryUsage();
      res.json({
        name: this.config.identity.name,
        pid: process.pid,
        uptime: process.uptime(),
        tasks: {
          running: this.agent.getRunningCount(),
          total: this.agent.listTasks().length,
        },
        channels: Array.from(this.channels.keys()),
        skills: this.skills.listSkills().length,
        cronJobs: this.scheduler.listJobs().length,
        wsClients: this.wsClients.size,
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
        },
        node: process.version,
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

    // ── Family data (calendar, meals, grocery list, school) ──
    this.app.get('/api/family', (_req: Request, res: Response) => {
      res.json(this.loadFamilyData());
    });

    this.app.put('/api/family', (req: Request, res: Response) => {
      this.saveFamilyData(req.body);
      res.json({ ok: true });
    });

    this.app.patch('/api/family', (req: Request, res: Response) => {
      const data = this.loadFamilyData();
      Object.assign(data, req.body);
      this.saveFamilyData(data);
      res.json(data);
    });

    // Recipe database
    const recipesFile = join(this.config.dataDir, 'recipes.json');
    const loadRecipes = (): Record<string, { ingredients: string[], recipe: string }> => {
      try { return JSON.parse(readFileSync(recipesFile, 'utf-8')); }
      catch { return {}; }
    };
    const saveRecipes = (data: any) => writeFileSync(recipesFile, JSON.stringify(data, null, 2));

    this.app.get('/api/family/recipes', (_req: Request, res: Response) => {
      res.json(loadRecipes());
    });

    this.app.put('/api/family/recipes/:name', (req: Request, res: Response) => {
      const recipes = loadRecipes();
      const name = (req.params.name as string).toLowerCase();
      recipes[name] = req.body;
      saveRecipes(recipes);
      res.json({ ok: true });
    });

    // Extract ingredients — checks local recipes first, only calls AI for unknown meals
    this.app.post('/api/family/ingredients', async (req: Request, res: Response) => {
      const { meal, pantry = [], existing = [] } = req.body;
      if (!meal) { res.status(400).json({ error: 'meal is required' }); return; }

      const family = this.loadFamilyData();
      const members = family.members || [];
      const familySize = members.length || 2; // default to 2 if not configured
      const adults = members.filter((m: any) => m.type === 'adult' || !m.type).length || familySize;
      const children = members.filter((m: any) => m.type === 'child' || m.type === 'toddler').length;
      const dietaryNotes = members.filter((m: any) => m.dietary).map((m: any) => `${m.name}: ${m.dietary}`);

      const recipes = loadRecipes();
      const key = meal.toLowerCase();

      // Check local recipe database first
      if (recipes[key]) {
        const cached = recipes[key];
        const filteredIngredients = cached.ingredients.filter((i: string) => {
          const il = i.toLowerCase();
          return !pantry.some((p: string) => p.toLowerCase() === il) &&
                 !existing.some((e: string) => e.toLowerCase() === il);
        });
        res.json({ ingredients: filteredIngredients, source: 'local', recipe: cached.recipe });
        return;
      }

      // Unknown meal — call AI with family size context
      const servesNote = `Serves ${familySize} (${adults} adults${children ? `, ${children} children` : ''}).`;
      const dietaryNote = dietaryNotes.length ? ` Dietary: ${dietaryNotes.join('; ')}.` : '';
      try {
        const { execSync } = await import('node:child_process');
        const prompt = `I need the recipe and grocery list for "${meal}". ${servesNote}${dietaryNote} Return ONLY valid JSON with this exact structure, no explanation:
{"ingredients": ["item1 with quantity", "item2 with quantity"], "recipe": "Step 1: ... Step 2: ..."}
The ingredients should be grocery item names with quantities scaled for ${familySize} people. The recipe should be concise cooking instructions.`;
        const result = execSync(
          `claude -p "${prompt.replace(/"/g, '\\"')}" --output-format text --dangerously-skip-permissions --model claude-sonnet-4-6`,
          { encoding: 'utf-8', timeout: 20000 }
        ).trim();

        const match = result.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : { ingredients: [], recipe: '' };

        // Save to local recipe database
        recipes[key] = { ingredients: parsed.ingredients || [], recipe: parsed.recipe || '' };
        saveRecipes(recipes);

        // Filter out pantry/existing
        const filteredIngredients = (parsed.ingredients || []).filter((i: string) => {
          const il = i.toLowerCase();
          return !pantry.some((p: string) => p.toLowerCase() === il) &&
                 !existing.some((e: string) => e.toLowerCase() === il);
        });

        res.json({ ingredients: filteredIngredients, source: 'ai', recipe: parsed.recipe || '' });
      } catch (err: any) {
        res.status(500).json({ error: err.message, ingredients: [], source: 'error' });
      }
    });

    // ── Grocery intelligence (under /api/family/* to stay in the Family tab grouping) ─
    // These are read-mostly views over JSON files the cron + watcher produce.
    // None of them touch the existing groceryList/Order Now flow — they layer
    // alongside it.

    const dealsFile      = join(this.config.dataDir, 'grocery-deals-latest.json');
    const watchlistFile  = join(this.config.dataDir, 'grocery-watchlist.json');
    const pricesFile     = join(this.config.dataDir, 'grocery-prices.jsonl');
    const mealPlanFile   = join(this.config.dataDir, 'meal-plan-latest.json');

    const readJsonOr = <T,>(path: string, fallback: T): T => {
      try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
      catch { return fallback; }
    };

    // GET /api/family/deals — today's rock-bottom snapshot from grocery-watch.mjs
    this.app.get('/api/family/deals', (_req: Request, res: Response) => {
      const report = readJsonOr<any>(dealsFile, null);
      if (!report) {
        res.json({ ok: false, reason: 'No snapshot yet — daily 06:00 cron has not run, or grocery-watch.mjs has never been invoked.' });
        return;
      }
      res.json(report);
    });

    // GET /api/family/watchlist — current watchlist, augmented with the most-
    // recent price observation per item per store from grocery-prices.jsonl
    this.app.get('/api/family/watchlist', (_req: Request, res: Response) => {
      const wl: any = readJsonOr(watchlistFile, { items: [] });
      // Build "latest price per item per store" map from the JSONL ring
      const latestByItem: Record<string, { w: number | null, c: number | null, ts: string }> = {};
      try {
        const text = readFileSync(pricesFile, 'utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line);
            const cur = latestByItem[rec.item];
            if (!cur || rec.ts > cur.ts) {
              latestByItem[rec.item] = { w: rec.woolworths_price ?? null, c: rec.coles_price ?? null, ts: rec.ts };
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* no log yet */ }
      // Decorate items with their latest prices
      const decorated = (wl.items || []).map((item: any) => ({
        ...item,
        latest: latestByItem[item.name] ?? null,
      }));
      res.json({ ...wl, items: decorated });
    });

    // POST /api/family/watchlist — add/remove items
    //   body: { action: "add" | "remove", item: { name, max_price, category, search_terms?, expected_promo?, expected_rrp?, target_stockpile?, notes? } }
    //   for remove, item.name (substring) is enough.
    this.app.post('/api/family/watchlist', (req: Request, res: Response) => {
      const { action, item } = req.body ?? {};
      if (!action || !item?.name) { res.status(400).json({ error: 'action and item.name required' }); return; }
      const wl: any = readJsonOr(watchlistFile, { items: [] });
      if (!wl.items) wl.items = [];
      if (action === 'remove') {
        const q = String(item.name).toLowerCase();
        const before = wl.items.length;
        wl.items = wl.items.filter((i: any) => !i.name.toLowerCase().includes(q));
        writeFileSync(watchlistFile, JSON.stringify(wl, null, 2));
        res.json({ ok: true, removed: before - wl.items.length });
        return;
      }
      if (action === 'add') {
        if (typeof item.max_price !== 'number' || !item.category) {
          res.status(400).json({ error: 'item.max_price (number) and item.category required for add' });
          return;
        }
        const idx = wl.items.findIndex((i: any) => i.name.toLowerCase() === item.name.toLowerCase());
        const entry = {
          name: item.name,
          max_price: item.max_price,
          category: item.category,
          search_terms: item.search_terms?.length ? item.search_terms : [item.name.toLowerCase()],
          expected_promo: item.expected_promo ?? null,
          expected_rrp:   item.expected_rrp   ?? null,
          min_stockpile:  idx >= 0 ? (wl.items[idx].min_stockpile ?? 0) : 0,
          target_stockpile: item.target_stockpile ?? 1,
          ...(item.notes ? { notes: item.notes } : {}),
        };
        if (idx >= 0) wl.items[idx] = entry; else wl.items.push(entry);
        writeFileSync(watchlistFile, JSON.stringify(wl, null, 2));
        res.json({ ok: true, entry, updated: idx >= 0 });
        return;
      }
      res.status(400).json({ error: `unknown action "${action}" — use add or remove` });
    });

    // GET /api/family/meal-plan — the 7-day dinner plan from meal-plan.mjs
    this.app.get('/api/family/meal-plan', (_req: Request, res: Response) => {
      const plan = readJsonOr<any>(mealPlanFile, null);
      if (!plan) {
        res.json({ ok: false, reason: 'No plan yet — Sunday 17:00 cron has not run, or meal-plan.mjs has never been invoked.' });
        return;
      }
      res.json(plan);
    });

    // POST /api/family/meal-plan/regenerate — fire meal-plan.mjs synchronously
    this.app.post('/api/family/meal-plan/regenerate', async (_req: Request, res: Response) => {
      try {
        const { execSync } = await import('node:child_process');
        const repoRoot = join(__dirname, '..');
        execSync(`node ${join(repoRoot, 'scripts/meal-plan.mjs')}`, { cwd: repoRoot, timeout: 30000 });
        const plan = readJsonOr<any>(mealPlanFile, null);
        res.json({ ok: true, plan });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // POST /api/family/meal-plan/apply — write the planner's picks into
    // familyData.meals so the existing Week grid shows them. Preserves any
    // manually-entered meals in the same slots; the planner only fills empty
    // dinner slots unless force=true is sent.
    this.app.post('/api/family/meal-plan/apply', (req: Request, res: Response) => {
      const { force = false } = req.body ?? {};
      const plan = readJsonOr<any>(mealPlanFile, null);
      if (!plan?.dinners?.length) { res.status(400).json({ error: 'No meal plan to apply — regenerate first' }); return; }
      const family = this.loadFamilyData();
      if (!family.meals) family.meals = {};
      let applied = 0, skipped = 0;
      for (const d of plan.dinners) {
        if (d.status !== 'planned') continue;
        if (!family.meals[d.date]) family.meals[d.date] = {};
        const existing = family.meals[d.date].dinner;
        if (existing && !force) { skipped++; continue; }
        family.meals[d.date].dinner = d.name;
        applied++;
      }
      this.saveFamilyData(family);
      res.json({ ok: true, applied, skipped });
    });

    // POST /api/family/grocery/import-deals — add selected rock-bottom items
    // to familyData.groceryList. The existing Order Now button takes it from there.
    //   body: { names: string[] }
    this.app.post('/api/family/grocery/import-deals', (req: Request, res: Response) => {
      const { names } = req.body ?? {};
      if (!Array.isArray(names) || names.length === 0) { res.status(400).json({ error: 'names[] required' }); return; }
      const family = this.loadFamilyData();
      if (!family.groceryList) family.groceryList = [];
      let added = 0;
      for (const name of names) {
        const exists = family.groceryList.some((i: any) => i.name.toLowerCase() === String(name).toLowerCase());
        if (exists) continue;
        family.groceryList.push({ name: String(name), checked: true, source: 'deals' });
        added++;
      }
      this.saveFamilyData(family);
      res.json({ ok: true, added });
    });

    // ── eero: home network full control ─────────────────────────────────
    const eeroError = (res: Response, err: any) => {
      const status = err?.status === 401 ? 401 : (err?.status || 500);
      res.status(status).json({ error: err?.message || 'eero error', body: err?.body });
    };
    const audit = (action: string, detail: any) => this.eeroStore.logAction(action, detail);

    // Status — what the dashboard reads on load. Returns the cached snapshot
    // (so the UI is instant) plus the current sampler config.
    this.app.get('/api/eero', (_req: Request, res: Response) => {
      const snapshot = this.eeroStore.loadSnapshot();
      const schedules = this.eeroScheduler.list();
      const now = new Date();
      // Annotate each device with a pausedReason explaining *why* it's
      // paused — manual, profile-paused manual, or a specific schedule.
      // The UI uses this so users can tell "the bedtime schedule paused this"
      // apart from "I clicked pause".
      if (snapshot?.devices) {
        for (const d of snapshot.devices as any[]) {
          d.pausedReason = computePausedReason(d, d.profile, schedules, now);
        }
      }
      res.json({
        authenticated: this.eero.isAuthenticated(),
        snapshot,
        config: this.eeroStore.loadConfig(),
        actions: this.eeroStore.readActions(50),
        alerts: this.eeroStore.loadAlerts(),
        // MACs of the host running gombwe — the UI badges any matching
        // device as "this device" so it's instantly identifiable.
        hostMacs: localMacAddresses(),
      });
    });

    this.app.get('/api/eero/alerts', (_req: Request, res: Response) => {
      res.json(this.eeroStore.loadAlerts());
    });

    this.app.post('/api/eero/alerts/:id/dismiss', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const dismissed = req.body?.dismissed !== false;
      const alerts = this.eeroStore.dismissAlert(id, dismissed);
      audit('alert.dismiss', { id, dismissed });
      res.json(alerts);
    });

    this.app.post('/api/eero/alerts/recompute', (_req: Request, res: Response) => {
      res.json(this.eeroStore.computeAlerts());
    });

    // ── Block schedules ────────────────────────────────────────────────
    this.app.get('/api/eero/schedules', (_req: Request, res: Response) => {
      res.json(this.eeroScheduler.list());
    });

    this.app.post('/api/eero/schedules', (req: Request, res: Response) => {
      const { name, target, rules, pauseUntil, enabled = true } = req.body || {};
      if (!name || !target || !target.type || !target.url) {
        res.status(400).json({ error: 'name and target {type, url} are required' });
        return;
      }
      const item = this.eeroScheduler.create({ name, target, rules, pauseUntil, enabled });
      audit('schedule.create', item);
      res.status(201).json(item);
    });

    this.app.put('/api/eero/schedules/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const item = this.eeroScheduler.update(id, req.body || {});
      if (!item) { res.status(404).json({ error: 'Not found' }); return; }
      audit('schedule.update', { id, patch: req.body });
      res.json(item);
    });

    this.app.delete('/api/eero/schedules/:id', (req: Request, res: Response) => {
      const id = req.params.id as string;
      const ok = this.eeroScheduler.delete(id);
      if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
      audit('schedule.delete', { id });
      res.json({ ok: true });
    });

    // ── NextDNS (DNS-based filtering) ─────────────────────────────────
    const nextdnsErr = (res: Response, err: any) => {
      const status = err?.status || 500;
      res.status(status).json({ error: err?.message || 'NextDNS error', body: err?.body });
    };

    this.app.get('/api/nextdns/config', (_req: Request, res: Response) => {
      const c = this.nextdns.loadConfig();
      // Redact the API key — UI only needs to know whether one is set.
      res.json({
        configured: !!(c.apiKey && c.configId),
        configId: c.configId || null,
        profileName: c.profileName || null,
        hasKey: !!c.apiKey,
        resolverIPs: this.nextdns.resolverIPs(),
        dohEndpoint: this.nextdns.dohEndpoint(),
      });
    });

    this.app.put('/api/nextdns/config', async (req: Request, res: Response) => {
      try {
        const { apiKey, configId, profileName } = req.body || {};
        const cfg = this.nextdns.saveConfig({ apiKey, configId, profileName });
        // If only an API key was provided, list profiles to discover the configId.
        if (cfg.apiKey && !cfg.configId) {
          const profs = await this.nextdns.listProfiles();
          const first = profs?.data?.[0];
          if (first) this.nextdns.saveConfig({ configId: first.id, profileName: first.name });
        }
        const out = this.nextdns.loadConfig();
        audit('nextdns.config', { configId: out.configId });
        res.json({ configured: !!(out.apiKey && out.configId), configId: out.configId, profileName: out.profileName });
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.get('/api/nextdns/profile', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.profile()); } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.get('/api/nextdns/denylist', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.denylist()); } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.post('/api/nextdns/denylist', async (req: Request, res: Response) => {
      try {
        const { domain } = req.body || {};
        if (!domain) { res.status(400).json({ error: 'domain required' }); return; }
        const out = await this.nextdns.addDeny(domain);
        audit('nextdns.deny.add', { domain });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.delete('/api/nextdns/denylist', async (req: Request, res: Response) => {
      try {
        const domain = (req.query.domain as string) || req.body?.domain;
        const out = await this.nextdns.removeDeny(domain);
        audit('nextdns.deny.remove', { domain });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.get('/api/nextdns/allowlist', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.allowlist()); } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.post('/api/nextdns/allowlist', async (req: Request, res: Response) => {
      try {
        const out = await this.nextdns.addAllow(req.body?.domain);
        audit('nextdns.allow.add', { domain: req.body?.domain });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.delete('/api/nextdns/allowlist', async (req: Request, res: Response) => {
      try {
        const domain = (req.query.domain as string) || req.body?.domain;
        const out = await this.nextdns.removeAllow(domain);
        audit('nextdns.allow.remove', { domain });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    // Parental services (TikTok, Instagram, etc) and categories (porn, gambling, …)
    this.app.get('/api/nextdns/services', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.parentalServices()); } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.post('/api/nextdns/services', async (req: Request, res: Response) => {
      try {
        const out = await this.nextdns.addParentalService(req.body?.id);
        audit('nextdns.service.add', { id: req.body?.id });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.delete('/api/nextdns/services', async (req: Request, res: Response) => {
      try {
        const id = (req.query.id as string) || req.body?.id;
        const out = await this.nextdns.removeParentalService(id);
        audit('nextdns.service.remove', { id });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.get('/api/nextdns/categories', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.parentalCategories()); } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.post('/api/nextdns/categories', async (req: Request, res: Response) => {
      try {
        const out = await this.nextdns.addParentalCategory(req.body?.id);
        audit('nextdns.category.add', { id: req.body?.id });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });
    this.app.delete('/api/nextdns/categories', async (req: Request, res: Response) => {
      try {
        const id = (req.query.id as string) || req.body?.id;
        const out = await this.nextdns.removeParentalCategory(id);
        audit('nextdns.category.remove', { id });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.patch('/api/nextdns/parental', async (req: Request, res: Response) => {
      try {
        const { field, value } = req.body || {};
        const out = await this.nextdns.setParentalToggle(field, !!value);
        audit('nextdns.parental.toggle', { field, value });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.patch('/api/nextdns/security', async (req: Request, res: Response) => {
      try {
        const { field, value } = req.body || {};
        const out = await this.nextdns.setSecurityToggle(field, !!value);
        audit('nextdns.security.toggle', { field, value });
        res.json(out);
      } catch (err: any) { nextdnsErr(res, err); }
    });

    this.app.get('/api/nextdns/logs', async (_req: Request, res: Response) => {
      try { res.json(await this.nextdns.logs()); } catch (err: any) { nextdnsErr(res, err); }
    });

    // Server-side proxy to test.nextdns.io. The plain test.nextdns.io is a
    // JS-redirect page; the JSON endpoint lives at <random>.test.nextdns.io,
    // resolved fresh each call so NextDNS can identify the source. This
    // reports whether the gombwe HOST is using NextDNS, not the browser.
    this.app.get('/api/nextdns/test', async (_req: Request, res: Response) => {
      try {
        const token = Array.from({ length: 20 }, () =>
          'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]
        ).join('');
        const r = await fetch(`https://${token}.test.nextdns.io/`, {
          headers: { Accept: 'application/json' },
        });
        const text = await r.text();
        try { res.json(JSON.parse(text)); }
        catch { res.json({ status: 'parse-error', raw: text.slice(0, 500) }); }
      } catch (err: any) {
        res.status(502).json({ status: 'unreachable', error: err.message });
      }
    });

    this.app.get('/api/nextdns/analytics', async (_req: Request, res: Response) => {
      try {
        const [status, domains] = await Promise.all([
          this.nextdns.analyticsStatus().catch(() => null),
          this.nextdns.analyticsTopDomains().catch(() => null),
        ]);
        res.json({ status, domains });
      } catch (err: any) { nextdnsErr(res, err); }
    });

    // Point the eero at NextDNS — sets the network's custom DNS to NextDNS
    // resolver IPs. Affects every device on the network at once.
    this.app.post('/api/eero/dns/point-at-nextdns', async (req: Request, res: Response) => {
      try {
        const ips = this.nextdns.resolverIPs();
        const url = req.body?.networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.request('PUT', url, { dns: { mode: 'custom', custom: { ips } } });
        audit('eero.dns.point-at-nextdns', { ips });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.post('/api/eero/dns/reset', async (req: Request, res: Response) => {
      try {
        const url = req.body?.networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.request('PUT', url, { dns: { mode: 'automatic' } });
        audit('eero.dns.reset', {});
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Convenience: pause a device or profile for N minutes (auto-unpause).
    this.app.post('/api/eero/schedules/pause-for', (req: Request, res: Response) => {
      const { target, minutes, name } = req.body || {};
      if (!target?.url || !target?.type || !minutes) {
        res.status(400).json({ error: 'target {type, url} and minutes are required' });
        return;
      }
      const item = this.eeroScheduler.pauseFor(target, Number(minutes), name);
      audit('schedule.pause-for', { target, minutes });
      res.status(201).json(item);
    });

    this.app.post('/api/eero/sync', async (req: Request, res: Response) => {
      try {
        const snap = await this.eeroStore.sync(req.body?.networkUrl);
        audit('sync', { networkUrl: snap.networkUrl, errors: snap.errors });
        res.json(snap);
      } catch (err: any) { eeroError(res, err); }
    });

    // Auth
    this.app.post('/api/eero/login', async (req: Request, res: Response) => {
      try {
        const out = await this.eero.login(req.body?.login);
        audit('login', { login: req.body?.login });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });
    this.app.post('/api/eero/verify', async (req: Request, res: Response) => {
      try {
        const out = await this.eero.verify(req.body?.code);
        audit('verify', {});
        // Sync immediately on successful verify so the UI has data.
        this.eeroStore.sync().catch(() => {});
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });
    this.app.post('/api/eero/logout', async (_req: Request, res: Response) => {
      await this.eero.logout();
      audit('logout', {});
      res.json({ ok: true });
    });

    // Sampler control
    this.app.put('/api/eero/config', (req: Request, res: Response) => {
      const cfg = this.eeroStore.saveConfig(req.body || {});
      audit('config', cfg);
      this.eeroStore.stopSampler();
      if (cfg.samplerEnabled) this.eeroStore.startSampler();
      res.json(cfg);
    });

    this.app.post('/api/eero/sampler', (req: Request, res: Response) => {
      const { enabled, intervalMs } = req.body || {};
      const cfg = this.eeroStore.setSampler(!!enabled, intervalMs);
      audit('sampler', cfg);
      res.json(cfg);
    });

    // Network
    this.app.post('/api/eero/network/reboot', async (req: Request, res: Response) => {
      try {
        const url = req.body?.networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.rebootNetwork(url);
        audit('network.reboot', { networkUrl: url });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.put('/api/eero/network/guest', async (req: Request, res: Response) => {
      try {
        const { networkUrl, enabled, name, password } = req.body || {};
        const url = networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.setGuestNetwork(url, !!enabled, { name, password });
        audit('network.guest', { networkUrl: url, enabled, name });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Speed test
    this.app.post('/api/eero/speedtest', async (req: Request, res: Response) => {
      try {
        const url = req.body?.networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.runSpeedtest(url);
        audit('speedtest.run', { networkUrl: url });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Eero hardware nodes
    this.app.post('/api/eero/eeros/reboot', async (req: Request, res: Response) => {
      try {
        const { eeroUrl } = req.body || {};
        if (!eeroUrl) { res.status(400).json({ error: 'eeroUrl required' }); return; }
        const out = await this.eero.rebootEero(eeroUrl);
        audit('eero.reboot', { eeroUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Devices — rename, pause, block, reassign profile
    this.app.put('/api/eero/devices/rename', async (req: Request, res: Response) => {
      try {
        const { deviceUrl, nickname } = req.body || {};
        const out = await this.eero.renameDevice(deviceUrl, nickname);
        audit('device.rename', { deviceUrl, nickname });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.put('/api/eero/devices/profile', async (req: Request, res: Response) => {
      try {
        const { deviceUrl, profileUrl } = req.body || {};
        if (!deviceUrl) { res.status(400).json({ error: 'deviceUrl required' }); return; }
        if (profileUrl) {
          const out = await this.eero.setDeviceProfile(deviceUrl, profileUrl);
          audit('device.profile', { deviceUrl, profileUrl });
          res.json(out);
          return;
        }
        // Removing a profile assignment requires editing the source profile —
        // the device-side null PUT is a no-op on eero's end. Find the source
        // profile from the snapshot and rewrite its device list without this one.
        const snap = this.eeroStore.loadSnapshot();
        const dev = (snap?.devices || []).find((d: any) => d.url === deviceUrl);
        const sourceProfileUrl = dev?.profile?.url;
        if (!sourceProfileUrl) { res.json({ ok: true, note: 'device had no profile' }); return; }
        const sourceProfile = (snap?.profiles || []).find((p: any) => p.url === sourceProfileUrl);
        const remaining = ((sourceProfile?.devices || []) as any[])
          .map(d => d.url || d)
          .filter(u => u !== deviceUrl);
        const out = await this.eero.setProfileDevices(sourceProfileUrl, remaining);
        audit('device.profile.clear', { deviceUrl, sourceProfileUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Replace a profile's entire device list (the canonical way to add/remove
    // devices in bulk).
    this.app.put('/api/eero/profiles/devices', async (req: Request, res: Response) => {
      try {
        const { profileUrl, deviceUrls } = req.body || {};
        if (!profileUrl || !Array.isArray(deviceUrls)) {
          res.status(400).json({ error: 'profileUrl and deviceUrls[] required' });
          return;
        }
        const out = await this.eero.setProfileDevices(profileUrl, deviceUrls);
        audit('profile.devices', { profileUrl, count: deviceUrls.length });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.put('/api/eero/devices/pause', async (req: Request, res: Response) => {
      try {
        const { deviceUrl, paused } = req.body || {};
        const out = await this.eero.setDevicePaused(deviceUrl, !!paused);
        audit('device.pause', { deviceUrl, paused });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.put('/api/eero/devices/block', async (req: Request, res: Response) => {
      try {
        const { deviceUrl, blocked } = req.body || {};
        const out = await this.eero.setDeviceBlocked(deviceUrl, !!blocked);
        audit('device.block', { deviceUrl, blocked });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Bulk pause/unpause: a power feature consumer routers don't offer.
    this.app.post('/api/eero/devices/bulk-pause', async (req: Request, res: Response) => {
      try {
        const { deviceUrls = [], paused } = req.body || {};
        const results = await Promise.allSettled(
          deviceUrls.map((u: string) => this.eero.setDevicePaused(u, !!paused)),
        );
        audit('device.bulk-pause', { count: deviceUrls.length, paused });
        res.json({
          ok: results.filter(r => r.status === 'fulfilled').length,
          failed: results.filter(r => r.status === 'rejected').length,
        });
      } catch (err: any) { eeroError(res, err); }
    });

    // Profiles — pause/unpause, create, delete, rename, schedules
    this.app.put('/api/eero/profiles/pause', async (req: Request, res: Response) => {
      try {
        const { profileUrl, paused } = req.body || {};
        const out = await this.eero.setProfilePaused(profileUrl, !!paused);
        audit('profile.pause', { profileUrl, paused });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.post('/api/eero/profiles', async (req: Request, res: Response) => {
      try {
        const { networkUrl, name } = req.body || {};
        const url = networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.createProfile(url, name);
        audit('profile.create', { name });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.put('/api/eero/profiles/update', async (req: Request, res: Response) => {
      try {
        const { profileUrl, body } = req.body || {};
        const out = await this.eero.updateProfile(profileUrl, body);
        audit('profile.update', { profileUrl, body });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.delete('/api/eero/profiles', async (req: Request, res: Response) => {
      try {
        const profileUrl = (req.query.profileUrl as string) || req.body?.profileUrl;
        const out = await this.eero.deleteProfile(profileUrl);
        audit('profile.delete', { profileUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.get('/api/eero/profiles/schedules', async (req: Request, res: Response) => {
      try {
        const out = await this.eero.profileSchedules(req.query.profileUrl as string);
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.post('/api/eero/profiles/schedules', async (req: Request, res: Response) => {
      try {
        const { profileUrl, schedule } = req.body || {};
        const out = await this.eero.createProfileSchedule(profileUrl, schedule);
        audit('profile.schedule.create', { profileUrl, schedule });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    this.app.delete('/api/eero/profiles/schedules', async (req: Request, res: Response) => {
      try {
        const scheduleUrl = (req.query.scheduleUrl as string) || req.body?.scheduleUrl;
        const out = await this.eero.deleteProfileSchedule(scheduleUrl);
        audit('profile.schedule.delete', { scheduleUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // Port forwards
    this.app.post('/api/eero/forwards', async (req: Request, res: Response) => {
      try {
        const { networkUrl, body } = req.body || {};
        const url = networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.createForward(url, body);
        audit('forward.create', body);
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });
    this.app.delete('/api/eero/forwards', async (req: Request, res: Response) => {
      try {
        const forwardUrl = (req.query.forwardUrl as string) || req.body?.forwardUrl;
        const out = await this.eero.deleteForward(forwardUrl);
        audit('forward.delete', { forwardUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // DHCP reservations
    this.app.post('/api/eero/reservations', async (req: Request, res: Response) => {
      try {
        const { networkUrl, body } = req.body || {};
        const url = networkUrl || (await this.eero.defaultNetworkUrl());
        const out = await this.eero.createReservation(url, body);
        audit('reservation.create', body);
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });
    this.app.delete('/api/eero/reservations', async (req: Request, res: Response) => {
      try {
        const reservationUrl = (req.query.reservationUrl as string) || req.body?.reservationUrl;
        const out = await this.eero.deleteReservation(reservationUrl);
        audit('reservation.delete', { reservationUrl });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });

    // History — for charts (devices online over time, usage, speedtests).
    this.app.get('/api/eero/history', (req: Request, res: Response) => {
      const limit = Number(req.query.limit || 1000);
      const type = (req.query.type as string) || undefined;
      res.json(this.eeroStore.readHistory(limit, type));
    });

    // Raw passthrough: full power. The dashboard "Raw API" panel hits this so
    // anything we didn't wrap explicitly (insights, advanced settings, etc.)
    // is still reachable.
    this.app.post('/api/eero/raw', async (req: Request, res: Response) => {
      try {
        const { method = 'GET', path, body } = req.body || {};
        if (!path) { res.status(400).json({ error: 'path is required' }); return; }
        const out = await this.eero.request(method, path, body);
        audit('raw', { method, path });
        res.json(out);
      } catch (err: any) { eeroError(res, err); }
    });
  }

  async start(): Promise<void> {
    // Load skills
    this.skills.load();
    console.log(`[gombwe] Loaded ${this.skills.listSkills().length} skills`);

    // Load MikroTik creds (optional — quietly disable network features if absent)
    if (mikrotik.load()) {
      try {
        getNetworkService();  // pre-construct so timers re-arm on startup
        console.log(`[gombwe] MikroTik configured @ ${mikrotik.host}`);
      } catch (err) {
        console.warn(`[gombwe] MikroTik configured but service init failed:`, err);
      }
      // Start the DNS log receiver — listens on udp:1514 for MikroTik's
      // remote-syslogged dns,packet stream. Fed by the logging-action config
      // we set up via REST during MikroTik bring-up.
      try {
        dnsReceiver().start();
      } catch (err) {
        console.warn(`[gombwe] dns-receiver failed to start:`, err);
      }

      // Bootstrap the local blocklist cache — fast load from disk if present,
      // background refresh if stale. Powers per-device category classification
      // (5b.2) and gives us a free domain→category index for the Usage chart.
      try {
        const { bootstrap: bootstrapBlocklistCache } = await import('./blocklist-cache.js');
        bootstrapBlocklistCache();
      } catch (err) {
        console.warn(`[gombwe] blocklist cache bootstrap failed:`, err);
      }

      // Start the per-device category enforcer. Subscribes to the DNS log
      // stream and, on any matched (mac × blocked-category) query, adds
      // dst-IP drop rules + kills conntrack. Audit-logs every attempt.
      try {
        const { startCategoryEnforcer } = await import('./category-enforcer.js');
        startCategoryEnforcer();
      } catch (err) {
        console.warn(`[gombwe] category enforcer failed to start:`, err);
      }

      // Start the passive mDNS listener (UDP/5353). Devices on the LAN broadcast
      // AirPlay / HomeKit / _device-info announcements; we just absorb them so
      // device names + Apple model codes show up in the dashboard.
      try {
        const { mdnsListener } = await import('./mdns-listener.js');
        await mdnsListener().start();
      } catch (err) {
        console.warn(`[gombwe] mdns listener failed to start:`, err);
      }

      // Start the snapshot collector — periodic MikroTik state → JSONL.
      // Replaces scripts/network-monitor.py so the capture pipeline lives
      // entirely inside gombwe and can't silently die in the background.
      try {
        const { startSnapshotCollector } = await import('./snapshot-collector.js');
        startSnapshotCollector();
      } catch (err) {
        console.warn(`[gombwe] snapshot collector failed to start:`, err);
      }

      // Start the history rollup pipeline (backfill any missing days, schedule
      // midnight write of yesterday's rollup). Local-first long-term storage.
      try {
        const { startHistoryRollup } = await import('./history-rollup.js');
        startHistoryRollup().catch(err => console.warn('[gombwe] history rollup failed:', err));
      } catch (err) {
        console.warn(`[gombwe] history rollup failed to start:`, err);
      }

      // Gzip raw JSONL older than 7 days, then daily. ~10× disk savings.
      try {
        const { startLogCompactor } = await import('./log-compactor.js');
        startLogCompactor();
      } catch (err) {
        console.warn(`[gombwe] log compactor failed to start:`, err);
      }

      // Start the AI policy scanner. Universal + flag-only: it scans EVERY
      // device with DNS activity, records flags for the dashboard, and never
      // auto-blocks or depends on kid-list membership.
      try {
        const scanner = policyScanner();
        scanner.on('flagged', evt => this.broadcast({
          type: 'network:policy:flagged' as never,
          data: evt,
          timestamp: new Date().toISOString(),
        }));
        scanner.on('blocked', evt => this.broadcast({
          type: 'network:policy:blocked' as never,
          data: evt,
          timestamp: new Date().toISOString(),
        }));
        scanner.start();
      } catch (err) {
        console.warn(`[gombwe] policy scanner failed to start:`, err);
      }

      // Start the NetFlow collector — records every connection (session) the
      // MikroTik exports (bytes + start/end/duration) for the usage dossier.
      try {
        netflowCollector().start();
      } catch (err) {
        console.warn(`[gombwe] netflow collector failed to start:`, err);
      }

      // Pre-build dossiers in the background so the Dossier view loads instantly
      // (forensicTimeline is expensive and grows with history). Warm shortly
      // after boot, then refresh every 15 min.
      try {
        const svc = getNetworkService();
        setTimeout(() => { try { svc.refreshAllDossiers(); } catch (e) { console.warn('[gombwe] dossier prebuild failed:', e); } }, 20_000);
        setInterval(() => { try { svc.refreshAllDossiers(); } catch { /* */ } }, 15 * 60 * 1000);
      } catch (err) {
        console.warn(`[gombwe] dossier prebuilder failed to start:`, err);
      }
    } else {
      console.log(`[gombwe] MikroTik not configured (no ~/.claude-gombwe/mikrotik.json) — network features disabled`);
    }

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

    // Start eero schedule reconciler (runs every 60s)
    this.eeroScheduler.start();
    console.log(`[gombwe] eero scheduler watching ${this.eeroScheduler.list().length} schedules`);

    // Start agentsform AI SDR (DynamoDB → Claude → SES outbound from ellison@)
    new AgentsformSdr().start();

    // Start eero sampler if enabled
    this.eeroStore.startSampler();
    const eeroCfg = this.eeroStore.loadConfig();
    if (eeroCfg.samplerEnabled) {
      console.log(`[gombwe] eero sampler running every ${Math.round(eeroCfg.samplerIntervalMs / 1000)}s`);
    }

    // Network dashboard live updates: broadcast router status every 5s so the
    // bandwidth meter and "live" indicator stay fresh without the client polling.
    // Skipped silently if MikroTik isn't configured.
    if (mikrotik.configured) {
      const broadcastStatus = async () => {
        try {
          const status = await getNetworkService().status();
          this.broadcast({ type: 'network:status:update', data: status, timestamp: new Date().toISOString() });
        } catch (err) {
          // One-line warn — don't spam the log if the router is briefly unreachable
          console.warn(`[network] status broadcast skipped: ${err instanceof Error ? err.message : err}`);
        }
      };
      setInterval(broadcastStatus, 5_000);
      console.log(`[gombwe] network status broadcaster running every 5s`);
    }

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
    this.eeroScheduler.stop();
    this.eeroStore.stopSampler();
    this.triggers.stopAll();
    this.scheduler.stopAll();
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    this.server.close();
  }
}
