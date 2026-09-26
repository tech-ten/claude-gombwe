/**
 * The approval gate in front of the grocery checkout.
 *
 * These are the three helpers the buy script leans on, tested with an injected
 * fetch and an injected exec so nothing here opens Chrome, reaches the gateway
 * or touches the real Keychain. The property under test throughout is that the
 * gate fails closed: only an explicit approval comes back `approved`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestApproval, readKeychain, postLedger } from './grocery-lib.mjs';

/**
 * Run without the helpers' progress lines. They are for a person watching an
 * order, not for the test report, and nothing here asserts on them.
 */
async function quiet(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** A fetch stand-in that replays canned replies and records every call. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error(`no stubbed reply for ${url}`);
    if (next instanceof Error) throw next;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls };
}

const pending = {
  id: 'ap-1',
  class: 'pay',
  status: 'pending',
  summary: 'Grocery order at coles: 11 items, total $84.20',
};

const ask = (fetchImpl, over = {}) => quiet(() => requestApproval({
  cls: 'pay',
  summary: pending.summary,
  params: { store: 'coles', total: '84.20' },
  fetchImpl,
  port: '18790',
  waitMs: 60_000,
  ...over,
}));

test('an auto class is approved without waiting', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { policy: 'auto' } }]);
  const result = await ask(fetchImpl);

  assert.deepEqual(result, { status: 'approved', auto: true });
  assert.equal(calls.length, 1, 'no long poll for an auto class');
  assert.equal(calls[0].url, 'http://127.0.0.1:18790/api/approvals/request');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    class: 'pay',
    summary: pending.summary,
    params: { store: 'coles', total: '84.20' },
  });
});

test('a confirm class polls until a person approves', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { policy: 'confirm', approval: pending } },
    { body: { ...pending, status: 'pending' } },
    { body: { ...pending, status: 'approved', decidedBy: 'owner' } },
  ]);
  const result = await ask(fetchImpl);

  assert.equal(result.status, 'approved');
  assert.equal(result.id, 'ap-1');
  assert.equal(calls.length, 3, 'one request then two waits');
  assert.equal(calls[1].url, 'http://127.0.0.1:18790/api/approvals/ap-1/wait?timeout=25000');
  assert.equal(calls[2].url, calls[1].url);
});

test('a confirm class that a person denies is denied', async () => {
  const { fetchImpl } = stubFetch([
    { body: { policy: 'confirm', approval: pending } },
    { body: { ...pending, status: 'denied', decidedBy: 'owner' } },
  ]);
  const result = await ask(fetchImpl);

  assert.equal(result.status, 'denied');
  assert.equal(result.id, 'ap-1');
  assert.match(result.reason, /denied by owner/);
});

test('a never class is denied with the reason to show', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { policy: 'never', reason: 'credential is set to never' } },
  ]);
  const result = await ask(fetchImpl, { cls: 'credential' });

  assert.deepEqual(result, { status: 'denied', reason: 'credential is set to never' });
  assert.equal(calls.length, 1, 'nothing to wait for');
});

test('a request that nobody decides within waitMs expires', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { policy: 'confirm', approval: pending } },
    { body: { ...pending, status: 'pending' } },
  ]);
  const result = await ask(fetchImpl, { waitMs: 0 });

  assert.equal(result.status, 'expired');
  assert.equal(result.id, 'ap-1');
  assert.equal(calls.length, 1, 'no time left to poll at all');
});

test('an unreachable gateway fails closed', async () => {
  const { fetchImpl } = stubFetch([new Error('ECONNREFUSED')]);
  const result = await ask(fetchImpl);

  assert.equal(result.status, 'denied');
  assert.match(result.reason, /couldn't reach gombwe/);
});

test('a 500 from the approvals route fails closed', async () => {
  const { fetchImpl } = stubFetch([{ ok: false, status: 500, body: {} }]);
  const result = await ask(fetchImpl);

  assert.equal(result.status, 'denied');
  assert.match(result.reason, /returned 500/);
});

test('readKeychain returns the trimmed secret', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    return { stdout: '123\n' };
  };
  assert.equal(await readKeychain('gombwe-grocery-cvv', { exec }), '123');
  assert.deepEqual(calls, [{
    file: 'security',
    args: ['find-generic-password', '-s', 'gombwe-grocery-cvv', '-w'],
  }]);
});

test('readKeychain returns null when the item is missing', async () => {
  const exec = async () => { throw new Error('SecKeychainSearchCopyNext: not found'); };
  assert.equal(await readKeychain('gombwe-grocery-cvv', { exec }), null);
  assert.equal(await readKeychain('', { exec }), null);
});

test('postLedger swallows a failed fetch', async () => {
  const { fetchImpl, calls } = stubFetch([new Error('ECONNREFUSED')]);
  const entry = { action: 'grocery.checkout', outcome: 'ok' };
  assert.equal(await quiet(() => postLedger(entry, { fetchImpl, port: '18790' })), null);
  assert.equal(calls[0].url, 'http://127.0.0.1:18790/api/ledger');
  assert.deepEqual(JSON.parse(calls[0].init.body), entry);
});

test('postLedger returns the recorded entry', async () => {
  const recorded = { id: 'l-1', time: '2026-09-27T00:00:00.000Z', action: 'grocery.cart' };
  const { fetchImpl } = stubFetch([{ body: recorded }]);
  assert.deepEqual(await postLedger({ action: 'grocery.cart' }, { fetchImpl }), recorded);
});
