import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from './scheduler.js';
import type { CronJob, GombweConfig, LedgerEvent } from './types.js';

function config(): GombweConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'gombwe-scheduler-'));
  return {
    port: 0, host: '127.0.0.1', dataDir, skillsDirs: [],
    agents: { maxConcurrent: 1, workingDir: dataDir },
    channels: {},
    identity: { name: 'gombwe' },
  } as GombweConfig;
}

/** Far enough out that croner never fires it during the test. */
const NEVER = '0 4 1 1 *';

/** Keep a passing run readable when the scheduler narrates a failure. */
function quiet<T>(fn: () => T): { value: T; said: string[] } {
  const said: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  try {
    return { value: fn(), said };
  } finally {
    console.error = err;
  }
}

test('a run reports one cron.<id>.run event and stamps lastRun', () => {
  const seen: LedgerEvent[] = [];
  const started: CronJob[] = [];
  const s = new Scheduler(config(), job => started.push(job), { onEvent: e => seen.push(e) });
  const job = s.createJob(NEVER, 'check the bins', 'web', 'cron:bins', 'Australia/Melbourne');

  assert.equal(s.fireForTest(job.id), true);

  assert.equal(started.length, 1, 'the gateway is handed the job to start');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, `cron.${job.id}.run`);
  assert.equal(seen[0].actor, 'cron');
  assert.equal(seen[0].target, job.id);
  assert.equal(seen[0].outcome, 'ok');
  assert.equal(seen[0].params?.expression, NEVER);
  assert.equal(seen[0].params?.timezone, 'Australia/Melbourne');
  assert.equal(seen[0].params?.channel, 'web');
  assert.ok(s.getJob(job.id)?.lastRun);

  s.stopAll();
});

test('a handoff that throws is reported as failed and does not escape', () => {
  const seen: LedgerEvent[] = [];
  const s = new Scheduler(config(), () => { throw new Error('task queue full'); }, {
    onEvent: e => seen.push(e),
  });
  const job = s.createJob(NEVER, 'p', 'web', 'cron:p');

  // Swallowed on purpose: croner keeps the timer, so tomorrow's tick still runs.
  const { said } = quiet(() => s.fireForTest(job.id));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, 'failed');
  assert.match(String(seen[0].error), /task queue full/);
  assert.match(said.join('\n'), /could not start/);

  s.stopAll();
});

test('fireForTest on an unknown job does nothing', () => {
  const seen: LedgerEvent[] = [];
  const s = new Scheduler(config(), () => {}, { onEvent: e => seen.push(e) });
  assert.equal(s.fireForTest('no-such-job'), false);
  assert.equal(seen.length, 0);
});

test('with no sink a run still hands the job over', () => {
  const started: CronJob[] = [];
  const s = new Scheduler(config(), job => started.push(job));
  const job = s.createJob(NEVER, 'p', 'web', 'cron:p');
  assert.equal(s.fireForTest(job.id), true);
  assert.equal(started.length, 1);
  s.stopAll();
});
