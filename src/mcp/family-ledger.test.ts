import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postLedger, ledgerPrincipal } from './family-ledger.js';

type Call = { url: string; init: RequestInit };

/** A fetch stand-in that records what it was handed and replies as told. */
function fakeFetch(reply: { ok: boolean; status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('posts the entry to the gateway ledger route on loopback', async () => {
  const { impl, calls } = fakeFetch({ ok: true, body: { id: 'abc', action: 'family.grocery.add' } });

  const stored = await postLedger(
    { action: 'family.grocery.add', params: { items: ['milk'] }, receipt: { added: ['milk'] } },
    { port: '12345', fetchImpl: impl },
  );

  assert.deepEqual(stored, { id: 'abc', action: 'family.grocery.add' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:12345/api/ledger');
  assert.equal(calls[0].init.method, 'POST');
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.action, 'family.grocery.add');
  assert.deepEqual(sent.params, { items: ['milk'] });
  // The MCP server only ever speaks for a person in a conversation.
  assert.equal(sent.actor, 'chat');
  assert.equal(sent.outcome, 'ok');
  assert.equal(typeof sent.principal, 'string');
});

test('an entry can override the default actor, outcome and principal', async () => {
  const { impl, calls } = fakeFetch({ ok: true });

  await postLedger(
    { action: 'family.meal.set', actor: 'task', outcome: 'failed', principal: 'mag', error: 'nope' },
    { port: 1, fetchImpl: impl },
  );

  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.actor, 'task');
  assert.equal(sent.outcome, 'failed');
  assert.equal(sent.principal, 'mag');
  assert.equal(sent.error, 'nope');
});

/** Run something with the failure note captured rather than printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = original;
  }
}

test('a non-2xx response is swallowed and reported as null', async () => {
  const { impl } = fakeFetch({ ok: false, status: 400 });
  const { value, logged } = await quietly(() =>
    postLedger({ action: 'family.grocery.add' }, { port: 1, fetchImpl: impl }));
  assert.equal(value, null);
  assert.match(logged.join('\n'), /400/);
});

test('a thrown fetch — gateway down — is swallowed and reported as null', async () => {
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const { value, logged } = await quietly(() =>
    postLedger({ action: 'family.grocery.add' }, { port: 1, fetchImpl: impl }));
  assert.equal(value, null);
  assert.match(logged.join('\n'), /ECONNREFUSED/);
});

/**
 * A gateway that never answers, but does respect the abort signal — what real
 * `fetch` does. Resolves after 5 s if nothing aborts it, which is far longer
 * than any of these tests are allowed to take.
 */
const wedgedGateway = (async (_url: any, init: any) => new Promise((resolve, reject) => {
  const slow = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) }), 5000);
  init?.signal?.addEventListener('abort', () => {
    clearTimeout(slow);
    reject(init.signal.reason ?? new Error('aborted'));
  });
})) as unknown as typeof fetch;

test('a gateway that never answers is abandoned, not waited on', async () => {
  const started = Date.now();
  const { value, logged } = await quietly(() =>
    postLedger({ action: 'family.grocery.add' }, { port: 1, fetchImpl: wedgedGateway, timeoutMs: 100 }));
  const elapsed = Date.now() - started;

  assert.equal(value, null, 'the tool call gets its answer, just without a ledger line');
  assert.ok(elapsed < 1000, `should give up in ~100ms, took ${elapsed}ms`);
  assert.match(logged.join('\n'), /did not answer within 100ms/);
});

test('the default gives the gateway two seconds and no more', async () => {
  const started = Date.now();
  const { value } = await quietly(() =>
    postLedger({ action: 'family.grocery.add' }, { port: 1, fetchImpl: wedgedGateway }));
  const elapsed = Date.now() - started;

  assert.equal(value, null);
  assert.ok(elapsed >= 1900, `should actually wait the default out, took only ${elapsed}ms`);
  assert.ok(elapsed < 3000, `should give up well before the 5s reply, took ${elapsed}ms`);
});

test('the request carries an abort signal for the real fetch to honour', async () => {
  const { impl, calls } = fakeFetch({ ok: true });
  await postLedger({ action: 'family.grocery.add' }, { port: 1, fetchImpl: impl });
  const signal = (calls[0].init as any).signal;
  assert.ok(signal, 'a signal is always passed, not only when a timeout is asked for');
  assert.equal(signal.aborted, false);
});

test('the principal comes from the environment and falls back to the owner', () => {
  assert.equal(ledgerPrincipal({ GOMBWE_PRINCIPAL: 'liam' } as NodeJS.ProcessEnv), 'liam');
  assert.equal(ledgerPrincipal({} as NodeJS.ProcessEnv), 'owner');
  assert.equal(ledgerPrincipal({ GOMBWE_PRINCIPAL: '  ' } as NodeJS.ProcessEnv), 'owner');
});
