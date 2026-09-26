import { Cron } from 'croner';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { CronJob, GombweConfig } from './types.js';
import { reportEvent, type LedgerEventSink } from './ledger.js';

export class Scheduler extends EventEmitter {
  private jobs: Map<string, CronJob> = new Map();
  private runners: Map<string, Cron> = new Map();
  private jobsFile: string;
  private onTrigger: (job: CronJob) => void;
  /** Set by the gateway so every run lands in the action ledger. */
  private onEvent?: LedgerEventSink;

  constructor(
    config: GombweConfig,
    onTrigger: (job: CronJob) => void,
    opts: { onEvent?: LedgerEventSink } = {},
  ) {
    super();
    this.jobsFile = join(config.dataDir, 'cron-jobs.json');
    this.onTrigger = onTrigger;
    this.onEvent = opts.onEvent;
    this.loadJobs();
  }

  setEventSink(onEvent: LedgerEventSink | undefined): void {
    this.onEvent = onEvent;
  }

  /**
   * One tick of a job: stamp it, hand it to the gateway, record the run.
   *
   * The outcome is the handoff, not the task — `onTrigger` starts an agent task
   * and returns; the task's own completion is recorded by the agent's events. A
   * throw here means the task never started, and it is swallowed so one bad job
   * does not take croner's timer down with it.
   */
  private fire(job: CronJob): void {
    job.lastRun = new Date().toISOString();
    this.persistJobs();

    let error: string | undefined;
    try {
      this.onTrigger(job);
    } catch (err: any) {
      error = err?.message ?? String(err);
      console.error(`[scheduler] job ${job.id} could not start: ${error}`);
    }

    reportEvent(this.onEvent, 'scheduler', {
      actor: 'cron',
      action: `cron.${job.id}.run`,
      target: job.id,
      params: { expression: job.expression, timezone: job.timezone, channel: job.channel },
      outcome: error ? 'failed' : 'ok',
      error,
    });

    this.emit('job:triggered', job);
  }

  /** Test seam: take one tick now, the way croner would. */
  fireForTest(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    this.fire(job);
    return true;
  }

  private loadJobs(): void {
    if (existsSync(this.jobsFile)) {
      const raw = readFileSync(this.jobsFile, 'utf-8');
      const jobs: CronJob[] = JSON.parse(raw);
      for (const job of jobs) {
        this.jobs.set(job.id, job);
      }
    }
  }

  private persistJobs(): void {
    const jobs = Array.from(this.jobs.values());
    writeFileSync(this.jobsFile, JSON.stringify(jobs, null, 2));
  }

  startAll(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled) this.schedule(job);
    }
  }

  stopAll(): void {
    for (const [id, runner] of this.runners) {
      runner.stop();
    }
    this.runners.clear();
  }

  createJob(expression: string, prompt: string, channel: string, sessionKey: string, timezone = 'UTC'): CronJob {
    const job: CronJob = {
      id: randomUUID(),
      expression,
      timezone,
      prompt,
      channel,
      sessionKey,
      enabled: true,
    };

    this.jobs.set(job.id, job);
    this.persistJobs();
    this.schedule(job);
    return job;
  }

  private schedule(job: CronJob): void {
    // Stop existing runner if any
    this.runners.get(job.id)?.stop();

    const runner = new Cron(job.expression, {
      timezone: job.timezone,
    }, () => this.fire(job));

    job.nextRun = runner.nextRun()?.toISOString();
    this.runners.set(job.id, runner);
    this.persistJobs();
  }

  deleteJob(jobId: string): boolean {
    const runner = this.runners.get(jobId);
    if (runner) {
      runner.stop();
      this.runners.delete(jobId);
    }
    const deleted = this.jobs.delete(jobId);
    if (deleted) this.persistJobs();
    return deleted;
  }

  toggleJob(jobId: string, enabled: boolean): CronJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    job.enabled = enabled;
    if (enabled) {
      this.schedule(job);
    } else {
      this.runners.get(jobId)?.stop();
      this.runners.delete(jobId);
    }
    this.persistJobs();
    return job;
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }
}
