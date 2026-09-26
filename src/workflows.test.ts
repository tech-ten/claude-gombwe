import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from './workflows.js';
import type { AgentRuntime } from './agent.js';
import type { GombweConfig, LedgerEvent } from './types.js';

function config(): GombweConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'gombwe-workflows-'));
  return {
    port: 0, host: '127.0.0.1', dataDir, skillsDirs: [],
    agents: { maxConcurrent: 1, workingDir: dataDir },
    channels: {},
    identity: { name: 'gombwe' },
  } as GombweConfig;
}

/** A Claude stand-in that answers each call in turn. An Error is thrown. */
function fakeAgent(...replies: (string | Error)[]): AgentRuntime {
  let i = 0;
  return {
    async chat() {
      const reply = replies[Math.min(i++, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return { response: reply, sessionId: null, ok: true };
    },
  } as unknown as AgentRuntime;
}

/** The engine narrates to the console; keep a passing run readable. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value?: T; thrown?: unknown; said: string[] }> {
  const said: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  console.error = console.log;
  try {
    return { value: await fn(), said };
  } catch (thrown) {
    return { thrown, said };
  } finally {
    console.log = log; console.error = err;
  }
}

test('each step reports one workflow.<name>.step event', async () => {
  const seen: LedgerEvent[] = [];
  const engine = new WorkflowEngine(config(), fakeAgent('reviewed', 'summarised'), () => {}, {
    onEvent: e => seen.push(e),
  });
  const wf = engine.createWorkflow('pr-review', '', { type: 'webhook', path: '/pr' }, [
    { name: 'review', prompt: 'review it' },
    { name: 'summarise', prompt: 'summarise {{previous}}' },
  ]);

  await quiet(() => engine.runWorkflow(wf.id));

  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(e => e.action), ['workflow.pr-review.step', 'workflow.pr-review.step']);
  assert.equal(seen[0].actor, 'trigger');
  assert.equal(seen[0].target, wf.id);
  assert.equal(seen[0].params?.step, 'review');
  assert.equal(seen[0].params?.index, 0);
  assert.equal(seen[0].params?.of, 2);
  assert.equal(seen[0].outcome, 'ok');
  assert.equal(seen[0].receipt?.outputHead, 'reviewed');
  assert.equal(seen[1].params?.step, 'summarise');
  assert.equal(seen[1].receipt?.outputHead, 'summarised');
});

test('a step skipped by its condition is reported as skipped, not silent', async () => {
  const seen: LedgerEvent[] = [];
  // The condition check is the first chat call; 'NO' skips the step.
  const engine = new WorkflowEngine(config(), fakeAgent('NO'), () => {}, {
    onEvent: e => seen.push(e),
  });
  const wf = engine.createWorkflow('nightly', '', { type: 'webhook', path: '/n' }, [
    { name: 'tidy', prompt: 'tidy up', condition: 'is there anything to tidy?' },
  ]);

  await quiet(() => engine.runWorkflow(wf.id));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, 'ok');
  assert.equal(seen[0].receipt?.skipped, true);
});

test('a step whose agent throws is reported as failed', async () => {
  const seen: LedgerEvent[] = [];
  const engine = new WorkflowEngine(config(), fakeAgent(new Error('claude is down')), () => {}, {
    onEvent: e => seen.push(e),
  });
  const wf = engine.createWorkflow('nightly', '', { type: 'webhook', path: '/n' }, [
    { name: 'tidy', prompt: 'tidy up' },
  ]);

  const { thrown } = await quiet(() => engine.runWorkflow(wf.id));

  assert.match(String((thrown as Error)?.message), /claude is down/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, 'failed');
  assert.match(String(seen[0].error), /claude is down/);
});

test('with no sink a run still completes', async () => {
  const engine = new WorkflowEngine(config(), fakeAgent('done'), () => {});
  const wf = engine.createWorkflow('solo', '', { type: 'webhook', path: '/s' }, [
    { name: 'one', prompt: 'do it' },
  ]);
  const { value, thrown } = await quiet(() => engine.runWorkflow(wf.id));
  assert.equal(thrown, undefined);
  assert.deepEqual(value, ['done']);
});
