import { Bot, Context } from 'grammy';
import type { ChannelAdapter, MessageHandler, IncomingMessage } from '../types.js';

/**
 * Telegram channel with session management.
 *
 * One Telegram chat can have multiple gombwe sessions:
 *   - A main chat session (conversational, remembers context)
 *   - Task outputs (clearly labeled, separate from chat)
 *   - Alert/trigger notifications (prefixed with source)
 *
 * Commands for navigation:
 *   /chats   — list active chat sessions
 *   /tasks   — list recent tasks with status
 *   /new     — start a fresh chat conversation
 *   /task    — view a specific task's output
 *   Everything else handled by the gateway's command system
 */
export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';
  private bot: Bot;
  private handler?: MessageHandler;
  private chatMap: Map<string, number> = new Map();
  // Track active session per Telegram chat (allows switching)
  private activeSessions: Map<number, string> = new Map();

  constructor(botToken: string) {
    this.bot = new Bot(botToken);

    this.bot.on('message:text', async (ctx: Context) => {
      if (!this.handler || !ctx.message?.text || !ctx.chat) return;

      const chatId = ctx.chat.id;
      const text = ctx.message.text;

      // Get or create session for this Telegram chat
      let sessionKey = this.activeSessions.get(chatId);
      if (!sessionKey) {
        sessionKey = `telegram:${chatId}:chat`;
        this.activeSessions.set(chatId, sessionKey);
      }
      this.chatMap.set(sessionKey, chatId);

      // Handle /new — create a fresh session
      if (text === '/new') {
        const newKey = `telegram:${chatId}:chat:${Date.now()}`;
        this.activeSessions.set(chatId, newKey);
        this.chatMap.set(newKey, chatId);
        await ctx.reply('Fresh conversation started. Previous context cleared.');
        return;
      }

      // Task commands — create a separate session for the task
      const taskCmds = ['/task', '/build', '/fix', '/deploy', '/refactor', '/test', '/create'];
      const isTask = taskCmds.some(c => text.toLowerCase().startsWith(c + ' ') || text.toLowerCase() === c);
      if (isTask) {
        const taskSessionKey = `telegram:${chatId}:task:${Date.now()}`;
        this.chatMap.set(taskSessionKey, chatId);

        const msg: IncomingMessage = {
          channel: 'telegram',
          sessionKey: taskSessionKey,
          text,
          sender: ctx.from?.username || ctx.from?.first_name || String(chatId),
          timestamp: new Date().toISOString(),
        };

        await ctx.reply(`🔧 *Task started*\n_${text.slice(0, 100)}_`, { parse_mode: 'Markdown' }).catch(() =>
          ctx.reply(`Task started: ${text.slice(0, 100)}`)
        );
        await this.handler(msg);
        return;
      }

      // Normal message — goes to the active chat session
      const msg: IncomingMessage = {
        channel: 'telegram',
        sessionKey,
        text,
        sender: ctx.from?.username || ctx.from?.first_name || String(chatId),
        timestamp: new Date().toISOString(),
      };

      await this.handler(msg);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register commands with Telegram so "/" shows the picker */
  async registerCommands(skillNames: string[]): Promise<void> {
    const commands = [
      // Built-in commands
      { command: 'help', description: 'Show all commands' },
      { command: 'new', description: 'Start a fresh conversation' },
      { command: 'tasks', description: 'List recent tasks' },
      { command: 'sessions', description: 'List active conversations' },
      { command: 'skills', description: 'List available skills' },
      { command: 'model', description: 'Switch model (opus/sonnet/haiku)' },
      { command: 'mode', description: 'Switch mode (chat/task)' },
      { command: 'cancel', description: 'Cancel a running task' },
      // Skills as commands
      ...skillNames.map(name => ({
        command: name,
        description: `Run /${name} skill`,
      })),
    ];

    // Telegram limits to 100 commands
    const limited = commands.slice(0, 100);

    try {
      await this.bot.api.setMyCommands(limited);
      console.log(`[telegram] Registered ${limited.length} commands`);
    } catch (err) {
      console.error('[telegram] Failed to register commands:', err);
    }
  }

  async start(): Promise<void> {
    console.log('[telegram] Starting bot...');
    this.bot.start({
      onStart: () => console.log('[telegram] Bot is running'),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    console.log('[telegram] Bot stopped');
  }

  async send(sessionKey: string, message: string): Promise<void> {
    let chatId = this.chatMap.get(sessionKey);

    // Handle notify keys — "notify:telegram" → send to first known chat
    if (!chatId && sessionKey.startsWith('notify:')) {
      chatId = this.chatMap.values().next().value;
    }

    if (!chatId) {
      console.warn(`[telegram] No chat ID for session ${sessionKey}`);
      return;
    }

    // Format based on message type
    let formatted = message;
    const isTaskOutput = sessionKey.includes(':task:');
    const isTrigger = sessionKey === 'triggers' || sessionKey.startsWith('notify:');

    if (isTaskOutput) {
      formatted = `📋 *Task Result*\n\n${message}`;
    } else if (isTrigger) {
      formatted = `⚡ ${message}`;
    }

    const chunks = this.chunkMessage(formatted, 4096);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
        return this.bot.api.sendMessage(chatId!, chunk);
      });
    }
  }

  private chunkMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt === -1 || splitAt < maxLen / 2) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
