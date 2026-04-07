import type { ChannelAdapter, MessageHandler } from '../types.js';

/**
 * Web channel adapter — messages come via the gateway's WebSocket.
 * This adapter doesn't manage its own transport; it bridges
 * the gateway WS <-> agent runtime.
 */
export class WebChannel implements ChannelAdapter {
  name = 'web';
  private handler?: MessageHandler;
  private sendFn?: (sessionKey: string, message: string) => void;

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  setSendFn(fn: (sessionKey: string, message: string) => void): void {
    this.sendFn = fn;
  }

  getHandler() {
    return this.handler;
  }

  async start(): Promise<void> {
    console.log('[web] Web channel ready');
  }

  async stop(): Promise<void> {
    // Nothing to clean up
  }

  async send(sessionKey: string, message: string): Promise<void> {
    if (this.sendFn) {
      this.sendFn(sessionKey, message);
    }
  }
}
