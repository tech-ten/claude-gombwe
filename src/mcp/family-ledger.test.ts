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

test('the principal comes from the environment and falls back to the owner', () => {
  assert.equal(ledgerPrincipal({ GOMBWE_PRINCIPAL: 'liam' } as NodeJS.ProcessEnv), 'liam');
  assert.equal(ledgerPrincipal({} as NodeJS.ProcessEnv), 'owner');
  assert.equal(ledgerPrincipal({ GOMBWE_PRINCIPAL: '  ' } as NodeJS.ProcessEnv), 'owner');
});
