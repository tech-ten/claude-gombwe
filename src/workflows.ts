import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Workflow, WorkflowStep, TriggerSource, GombweConfig } from './types.js';
import { AgentRuntime } from './agent.js';

/**
 * Workflow engine — multi-step autonomous pipelines.
 *
 * A workflow is: trigger → step 1 → step 2 → step 3 → ...
 * Each step's output feeds into the next step as {{previous}}.
 * Each step can optionally notify specific channels.
 * Steps can have conditions — skipped if condition not met.
 *
 * Example workflow:
 *   Name: "PR Review Pipeline"
 *   Trigger: webhook /github-pr
 *   Steps:
 *     1. "Review the code changes for bugs and security issues"
 *     2. "Based on the review: {{previous}}, draft GitHub review comments"
 *     3. "Summarize the review for Slack" → notify: ["telegram"]
 */
export class WorkflowEngine extends EventEmitter {
  private workflows: Map<string, Workflow> = new Map();
  private workflowsFile: string;
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
    this.workflowsFile = join(config.dataDir, 'workflows.json');
    this.loadWorkflows();
  }

  private loadWorkflows(): void {
    if (existsSync(this.workflowsFile)) {
      const raw = readFileSync(this.workflowsFile, 'utf-8');
      const workflows: Workflow[] = JSON.parse(raw);
      for (const w of workflows) {
        this.workflows.set(w.id, w);
      }
    }
  }

  private persistWorkflows(): void {
    writeFileSync(this.workflowsFile, JSON.stringify(Array.from(this.workflows.values()), null, 2));
  }

  createWorkflow(
    name: string,
    description: string,
    trigger: TriggerSource,
    steps: WorkflowStep[],
  ): Workflow {
    const workflow: Workflow = {
      id: randomUUID(),
      name,
      description,
      enabled: true,
      trigger,
      steps,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.workflows.set(workflow.id, workflow);
    this.persistWorkflows();
    return workflow;
  }

  deleteWorkflow(id: string): boolean {
    const deleted = this.workflows.delete(id);
    if (deleted) this.persistWorkflows();
    return deleted;
  }

  toggleWorkflow(id: string, enabled: boolean): Workflow | undefined {
    const wf = this.workflows.get(id);
    if (!wf) return undefined;
    wf.enabled = enabled;
    this.persistWorkflows();
    return wf;
  }

  listWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /** Run a workflow manually or from a trigger */
  async runWorkflow(id: string, triggerContext?: string): Promise<string[]> {
    const workflow = this.workflows.get(id);
    if (!workflow || !workflow.enabled) return [];

    workflow.runCount++;
    workflow.lastRun = new Date().toISOString();
    this.persistWorkflows();
    this.emit('workflow:started', workflow);

    console.log(`[workflow] Running: ${workflow.name} (run #${workflow.runCount})`);

    const outputs: string[] = [];
    let previousOutput = triggerContext || '';

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];

      // Check condition if present
      if (step.condition) {
        const conditionCheck = await this.agent.chat(
          `Based on this context, should this step be executed? Condition: "${step.condition}"\n\nContext: ${previousOutput}\n\nRespond with only YES or NO.`,
          this.config.agents.workingDir,
        );
        if (conditionCheck.response.trim().toUpperCase().startsWith('NO')) {
          console.log(`[workflow] Skipping step ${i + 1} "${step.name}" — condition not met`);
          outputs.push(`[skipped: ${step.name}]`);
          continue;
        }
      }

      // Build prompt with previous output injected
      const prompt = step.prompt.replace(/\{\{previous\}\}/g, previousOutput);

      console.log(`[workflow] Step ${i + 1}/${workflow.steps.length}: ${step.name}`);
      this.emit('workflow:step', { workflow, step, index: i });

      const result = await this.agent.chat(prompt, this.config.agents.workingDir);
      previousOutput = result.response;
      outputs.push(previousOutput);

      // Notify if configured
      if (step.notify && step.notify.length > 0) {
        const message = `**[${workflow.name} — ${step.name}]**\n${previousOutput}`;
        this.notifyFn(step.notify, message);
      }
    }

    this.emit('workflow:completed', { workflow, outputs });
    console.log(`[workflow] Completed: ${workflow.name}`);

    return outputs;
  }

  /** Find workflows matching a webhook path and run them */
  async handleWebhook(path: string, body: unknown): Promise<Workflow[]> {
    const ran: Workflow[] = [];
    for (const wf of this.workflows.values()) {
      if (!wf.enabled) continue;
      if (wf.trigger.type === 'webhook' && wf.trigger.path === path) {
        await this.runWorkflow(wf.id, JSON.stringify(body));
        ran.push(wf);
      }
    }
    return ran;
  }
}
