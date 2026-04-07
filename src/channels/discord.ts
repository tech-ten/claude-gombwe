import { Client, GatewayIntentBits, Events, TextChannel, DMChannel } from 'discord.js';
import type { ChannelAdapter, MessageHandler, IncomingMessage } from '../types.js';

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private client: Client;
  private handler?: MessageHandler;
  private botToken: string;
  private channelMap: Map<string, string> = new Map();
  // Named channel registry — map friendly names to Discord channel IDs
  // e.g. "alerts" → "123456789", "tasks" → "987654321"
  private namedChannels: Map<string, string> = new Map();

  constructor(botToken: string) {
    this.botToken = botToken;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !this.handler) return;

      const channelId = message.channel.id;
      const guildId = message.guild?.id || 'dm';
      const sessionKey = `discord:${guildId}:${channelId}`;
      this.channelMap.set(sessionKey, channelId);

      // Auto-register channel name for easy routing
      if (message.channel instanceof TextChannel) {
        this.namedChannels.set(message.channel.name, channelId);
      }

      const msg: IncomingMessage = {
        channel: 'discord',
        sessionKey,
        text: message.content,
        sender: message.author.username,
        timestamp: new Date().toISOString(),
      };

      await this.handler(msg);
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log('[discord] Starting bot...');
    await this.client.login(this.botToken);
    console.log(`[discord] Bot is running as ${this.client.user?.tag}`);

    // Auto-discover all text channels and register them by name
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel instanceof TextChannel) {
          this.namedChannels.set(channel.name, channel.id);
          const sessionKey = `discord:${guild.id}:${channel.id}`;
          this.channelMap.set(sessionKey, channel.id);
        }
      }
    }

    const channelNames = Array.from(this.namedChannels.keys());
    if (channelNames.length > 0) {
      console.log(`[discord] Channels: ${channelNames.join(', ')}`);
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    console.log('[discord] Bot stopped');
  }

  /**
   * Send a message to a session key OR a named channel.
   *
   * Supports:
   *   - Session key: "discord:guildId:channelId"
   *   - Named channel: "discord:#alerts" or just "alerts"
   *   - Notify key: "notify:discord" (sends to first available channel)
   */
  async send(sessionKey: string, message: string): Promise<void> {
    let channelId: string | undefined;

    // Try direct session key lookup first
    channelId = this.channelMap.get(sessionKey);

    // Try named channel: "discord:#alerts" or "#alerts" or "alerts"
    if (!channelId) {
      const name = sessionKey
        .replace(/^discord:/, '')
        .replace(/^#/, '');
      channelId = this.namedChannels.get(name);
    }

    // Try notify key: "notify:discord" — send to first channel
    if (!channelId && sessionKey.startsWith('notify:')) {
      channelId = this.namedChannels.values().next().value;
    }

    if (!channelId) {
      console.warn(`[discord] No channel for: ${sessionKey}`);
      return;
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof DMChannel)) return;

    const chunks = this.chunkMessage(message, 2000);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  /** Get a list of discovered channel names */
  getChannelNames(): string[] {
    return Array.from(this.namedChannels.keys());
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
