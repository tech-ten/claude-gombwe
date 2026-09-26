import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerEngine } from './triggers.js';
import type { AgentRuntime } from './agent.js';
import type { EventTrigger, GombweConfig, LedgerEvent } from './types.js';

/** Just enough config for the engine: a scratch data dir and a working dir. */
function config(): GombweConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'gombwe-triggers-'));
  return {
    port: 0, host: '127.0.0.1', dataDir, skillsDirs: [],
    agents: { maxConcurrent: 1, workingDir: dataDir },
    channels: {},
    identity: { name: 'gombwe' },
  } as GombweConfig;
}

/** A Claude stand-in: one canned reply, or a throw. */
function fakeAgent(reply: string | Error): AgentRuntime {
  return {
    async chat() {
      if (reply instanceof Error) throw reply;
      return { response: reply, sessionId: null, ok: true };
    },
  } as unknown as AgentRuntime;
}

/**
 * The engines narrate to the console. Silence them so a passing run stays
 * readable, and hand back what was said for the tests that care.
 */
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

function trigger(over: Partial<EventTrigger> = {}): EventTrigger {
  return {
    id: 'trig-1',
    name: 'bin-night',
    enabled: true,
    source: { type: 'poll_prompt', prompt: 'is it bin night?' },
    action: { prompt: 'tell the house' },
    pollInterval: 300,
    triggerCount: 0,
    ...over,
  } as EventTrigger;
}

test('a firing reports one trigger.<name>.fired event', async () => {
  const seen: LedgerEvent[] = [];
  const engine = new TriggerEngine(config(), fakeAgent('put the bins out'), () => {}, {
    onEvent: e => seen.push(e),
  });

  await quiet(() => engine.fireForTest(trigger(), 'TRIGGERED'));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'trigger.bin-night.fired');
  assert.equal(seen[0].actor, 'trigger');
  assert.equal(seen[0].target, 'trig-1');
  assert.equal(seen[0].outcome, 'ok');
  assert.equal(seen[0].params?.source, 'poll_prompt');
  assert.equal(seen[0].params?.count, 1);
});

test('an action that throws is reported as failed and still propagates', async () => {
  const seen: LedgerEvent[] = [];
  const engine = new TriggerEngine(config(), fakeAgent(new Error('claude is down')), () => {}, {
    onEvent: e => seen.push(e),
  });

  const { thrown } = await quiet(() => engine.fireForTest(trigger()));
  assert.match(String((thrown as Error)?.message), /claude is down/,
    'the caller still learns the action failed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, 'failed');
  assert.match(String(seen[0].error), /claude is down/);
});

test('setEventSink attaches a sink after construction', async () => {
  const seen: LedgerEvent[] = [];
  const engine = new TriggerEngine(config(), fakeAgent('ok'), () => {});

  await quiet(() => engine.fireForTest(trigger()));
  assert.equal(seen.length, 0, 'no sink, no event, no crash');

  engine.setEventSink(e => seen.push(e));
  await quiet(() => engine.fireForTest(trigger()));
  assert.equal(seen.length, 1);
});

test('a sink that throws does not stop the trigger', async () => {
  const engine = new TriggerEngine(config(), fakeAgent('ok'), () => {}, {
    onEvent: () => { throw new Error('bad sink'); },
  });
  const { thrown, said } = await quiet(() => engine.fireForTest(trigger()));
  assert.equal(thrown, undefined, 'the fire path swallows the sink failure');
  assert.match(said.join('\n'), /event sink threw/);
});
