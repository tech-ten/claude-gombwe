import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GombweConfig, WSEvent, IncomingMessage, ChannelAdapter } from './types.js';
import { saveConfig } from './config.js';
import { AgentRuntime } from './agent.js';
import { SessionManager } from './session.js';
import { SkillLoader, executeSkillTool } from './skills.js';
import { Scheduler } from './scheduler.js';
import { TriggerEngine } from './triggers.js';
import { WorkflowEngine } from './workflows.js';
import { WebChannel } from './channels/web.js';
import { TelegramChannel } from './channels/telegram.js';
import { DiscordChannel } from './channels/discord.js';
import { EeroClient } from './eero.js';
import { EeroStore } from './eero-store.js';

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
        await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey);
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

      const result = await this.agent.chat(
        chatMessage,
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
          `/model <name> — switch model (opus/sonnet/haiku)\n\n` +
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
        await this.agent.runTask(fullPrompt, msg.channel, msg.sessionKey);
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
        await this.agent.runTask(buyPrompt, msg.channel, msg.sessionKey);
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
          await this.agent.runTask(prompt, msg.channel, msg.sessionKey);
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

    // ── eero: home network full control ─────────────────────────────────
    const eeroError = (res: Response, err: any) => {
      const status = err?.status === 401 ? 401 : (err?.status || 500);
      res.status(status).json({ error: err?.message || 'eero error', body: err?.body });
    };
    const audit = (action: string, detail: any) => this.eeroStore.logAction(action, detail);

    // Status — what the dashboard reads on load. Returns the cached snapshot
    // (so the UI is instant) plus the current sampler config.
    this.app.get('/api/eero', (_req: Request, res: Response) => {
      res.json({
        authenticated: this.eero.isAuthenticated(),
        snapshot: this.eeroStore.loadSnapshot(),
        config: this.eeroStore.loadConfig(),
        actions: this.eeroStore.readActions(50),
        alerts: this.eeroStore.loadAlerts(),
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
        const out = await this.eero.setDeviceProfile(deviceUrl, profileUrl ?? null);
        audit('device.profile', { deviceUrl, profileUrl });
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

    // Start eero sampler if enabled
    this.eeroStore.startSampler();
    const eeroCfg = this.eeroStore.loadConfig();
    if (eeroCfg.samplerEnabled) {
      console.log(`[gombwe] eero sampler running every ${Math.round(eeroCfg.samplerIntervalMs / 1000)}s`);
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
    this.eeroStore.stopSampler();
    this.triggers.stopAll();
    this.scheduler.stopAll();
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    this.server.close();
  }
}
