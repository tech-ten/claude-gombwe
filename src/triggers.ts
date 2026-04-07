import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EventTrigger, TriggerSource, TriggerAction, GombweConfig } from './types.js';
import { AgentRuntime } from './agent.js';

/**
 * Event trigger engine — the core of proactive behavior.
 *
 * Watches for events and fires actions when conditions are met.
 * Each trigger has a source (what to watch) and an action (what to do).
 *
 * Sources:
 *   - poll_prompt: periodically ask Claude "has X happened?" — if yes, fire action
 *   - webhook: external HTTP POST triggers it
 *   - file_watch: fires when a file/directory changes
 *   - url_change: fires when a web page changes
 *   - schedule: cron + condition (like cron but with an AI-evaluated condition)
 *
 * Actions:
 *   - prompt: tell Claude what to do
 *   - notify: send the result to specific channels
 *   - chain: follow-up actions (output of one feeds into next)
 */
export class TriggerEngine extends EventEmitter {
  private triggers: Map<string, EventTrigger> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private fileStates: Map<string, number> = new Map(); // mtime tracking for file_watch
  private triggersFile: string;
  private agent: AgentRuntime;
  private config: GombweConfig;
  private notifyFn: (channels: string[], message: string) => void;

  constructor(
    config: GombweConfig,
    agent: AgentRuntime,
    notifyFn: (channels: string[], message: string) => void,
  ) {
    super();
    this.config = config;
    this.agent = agent;
    this.notifyFn = notifyFn;
    this.triggersFile = join(config.dataDir, 'triggers.json');
    this.loadTriggers();
  }

  private loadTriggers(): void {
    if (existsSync(this.triggersFile)) {
      const raw = readFileSync(this.triggersFile, 'utf-8');
      const triggers: EventTrigger[] = JSON.parse(raw);
      for (const t of triggers) {
        this.triggers.set(t.id, t);
      }
    }
  }

  private persistTriggers(): void {
    const triggers = Array.from(this.triggers.values());
    writeFileSync(this.triggersFile, JSON.stringify(triggers, null, 2));
  }

  startAll(): void {
    for (const trigger of this.triggers.values()) {
      if (trigger.enabled) this.startTrigger(trigger);
    }
    console.log(`[triggers] Started ${this.timers.size} event triggers`);
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  createTrigger(
    name: string,
    source: TriggerSource,
    action: TriggerAction,
    pollInterval: number = 300,
    condition?: string,
  ): EventTrigger {
    const trigger: EventTrigger = {
      id: randomUUID(),
      name,
      enabled: true,
      source,
      action,
      condition,
      pollInterval,
      triggerCount: 0,
    };

    this.triggers.set(trigger.id, trigger);
    this.persistTriggers();
    this.startTrigger(trigger);
    return trigger;
  }

  deleteTrigger(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) { clearInterval(timer); this.timers.delete(id); }
    const deleted = this.triggers.delete(id);
    if (deleted) this.persistTriggers();
    return deleted;
  }

  toggleTrigger(id: string, enabled: boolean): EventTrigger | undefined {
    const trigger = this.triggers.get(id);
    if (!trigger) return undefined;
    trigger.enabled = enabled;
    if (enabled) {
      this.startTrigger(trigger);
    } else {
      const timer = this.timers.get(id);
      if (timer) { clearInterval(timer); this.timers.delete(id); }
    }
    this.persistTriggers();
    return trigger;
  }

  listTriggers(): EventTrigger[] {
    return Array.from(this.triggers.values());
  }

  getTrigger(id: string): EventTrigger | undefined {
    return this.triggers.get(id);
  }

  /** Handle incoming webhook — find matching triggers and fire them */
  async handleWebhook(path: string, body: unknown): Promise<EventTrigger[]> {
    const fired: EventTrigger[] = [];
    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (trigger.source.type === 'webhook' && trigger.source.path === path) {
        await this.fireTrigger(trigger, JSON.stringify(body));
        fired.push(trigger);
      }
    }
    return fired;
  }

  private startTrigger(trigger: EventTrigger): void {
    // Clear existing timer
    const existing = this.timers.get(trigger.id);
    if (existing) clearInterval(existing);

    const source = trigger.source;

    switch (source.type) {
      case 'poll_prompt': {
        // Periodically ask Claude to check something
        const timer = setInterval(() => this.checkPollTrigger(trigger), trigger.pollInterval * 1000);
        this.timers.set(trigger.id, timer);
        break;
      }

      case 'file_watch': {
        // Check file mtime periodically
        const timer = setInterval(() => this.checkFileWatch(trigger), trigger.pollInterval * 1000);
        this.timers.set(trigger.id, timer);
        // Record initial state
        try {
          const stat = statSync(source.path);
          this.fileStates.set(trigger.id, stat.mtimeMs);
        } catch {}
        break;
      }

      case 'url_change': {
        // Poll a URL for changes
        const timer = setInterval(() => this.checkUrlChange(trigger), trigger.pollInterval * 1000);
        this.timers.set(trigger.id, timer);
        break;
      }

      case 'webhook': {
        // Webhooks are handled passively via handleWebhook() — no timer needed
        break;
      }

      case 'schedule': {
        // Use cron for scheduling but with a condition check
        // For simplicity, treat as poll with cron-aligned interval
        const timer = setInterval(() => this.checkScheduleTrigger(trigger), trigger.pollInterval * 1000);
        this.timers.set(trigger.id, timer);
        break;
      }
    }
  }

  private async checkPollTrigger(trigger: EventTrigger): Promise<void> {
    if (trigger.source.type !== 'poll_prompt') return;
    trigger.lastChecked = new Date().toISOString();
    this.persistTriggers();

    // Ask Claude: "Check this condition. Reply with TRIGGERED if the condition is met, otherwise reply NOT_TRIGGERED."
    const checkPrompt = `You are monitoring for an event. Check the following and respond with ONLY "TRIGGERED" if the condition is met, or "NOT_TRIGGERED" if it is not. No other text.

Condition to check: ${trigger.source.prompt}
${trigger.condition ? `\nAdditional condition: ${trigger.condition}` : ''}`;

    const result = await this.agent.chat(checkPrompt, this.config.agents.workingDir);

    if (result.response.includes('TRIGGERED') && !result.response.includes('NOT_TRIGGERED')) {
      await this.fireTrigger(trigger, result.response);
    }
  }

  private async checkFileWatch(trigger: EventTrigger): Promise<void> {
    if (trigger.source.type !== 'file_watch') return;
    trigger.lastChecked = new Date().toISOString();

    try {
      const stat = statSync(trigger.source.path);
      const prevMtime = this.fileStates.get(trigger.id);

      if (prevMtime !== undefined && stat.mtimeMs !== prevMtime) {
        this.fileStates.set(trigger.id, stat.mtimeMs);
        await this.fireTrigger(trigger, `File changed: ${trigger.source.path}`);
      } else {
        this.fileStates.set(trigger.id, stat.mtimeMs);
      }
    } catch {
      // File doesn't exist or can't be read
    }

    this.persistTriggers();
  }

  private async checkUrlChange(trigger: EventTrigger): Promise<void> {
    if (trigger.source.type !== 'url_change') return;
    trigger.lastChecked = new Date().toISOString();
    this.persistTriggers();

    // Use Claude with fetch MCP to check the URL
    const checkPrompt = `Fetch this URL and check if its content has changed: ${trigger.source.url}
${trigger.source.selector ? `Focus on this part of the page: ${trigger.source.selector}` : ''}

If you detect any meaningful changes or new content, respond starting with "CHANGED:" followed by a summary.
If nothing significant changed, respond with "NO_CHANGE".`;

    const result = await this.agent.chat(checkPrompt, this.config.agents.workingDir);

    if (result.response.startsWith('CHANGED:')) {
      await this.fireTrigger(trigger, result.response);
    }
  }

  private async checkScheduleTrigger(trigger: EventTrigger): Promise<void> {
    if (trigger.source.type !== 'schedule') return;
    // Schedule triggers with conditions — check the condition
    if (trigger.condition) {
      await this.checkPollTrigger({ ...trigger, source: { type: 'poll_prompt', prompt: trigger.condition } });
    }
  }

  private async fireTrigger(trigger: EventTrigger, context: string): Promise<void> {
    trigger.lastTriggered = new Date().toISOString();
    trigger.triggerCount++;
    this.persistTriggers();
    this.emit('trigger:fired', trigger);

    console.log(`[triggers] Fired: ${trigger.name} (${trigger.triggerCount} times)`);

    // Execute the action
    await this.executeAction(trigger.action, context, trigger.name);
  }

  private async executeAction(action: TriggerAction, context: string, triggerName: string): Promise<void> {
    const prompt = `${action.prompt}\n\nContext from trigger "${triggerName}":\n${context}`;

    const result = await this.agent.chat(prompt, this.config.agents.workingDir);

    // Notify channels
    if (action.notify && action.notify.length > 0) {
      const message = `**[${triggerName}]**\n${result.response}`;
      this.notifyFn(action.notify, message);
    }

    // Execute chain (workflow steps)
    if (action.chain && action.chain.length > 0) {
      let previousOutput = result.response;
      for (const step of action.chain) {
        const stepPrompt = step.prompt.replace(/\{\{previous\}\}/g, previousOutput);
        const stepResult = await this.agent.chat(stepPrompt, this.config.agents.workingDir);
        previousOutput = stepResult.response;

        if (step.notify && step.notify.length > 0) {
          this.notifyFn(step.notify, `**[${triggerName}]**\n${previousOutput}`);
        }
      }
    }
  }
}
