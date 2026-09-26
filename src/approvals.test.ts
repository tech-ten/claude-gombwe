import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Approvals, DEFAULT_POLICIES, matchApprovalId } from './approvals.js';
import type { ApprovalRequest } from './approvals.js';
import { Ledger } from './ledger.js';
import { Principals } from './permissions.js';
import type { Principal } from './permissions.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-approvals-'));

/** A clock the tests move by hand, so expiry needs no real waiting. */
function clock(start = Date.parse('2026-09-27T09:00:00.000Z')) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
  };
}

function build(opts: { dataDir?: string; ttlMs?: number; now?: () => Date } = {}) {
  const dataDir = opts.dataDir ?? dir();
  const ledger = new Ledger(dataDir);
  const principals = new Principals(dataDir);
  principals.upsert({ id: 'mag', name: 'Mag', role: 'adult', bindings: [], grants: {} });
  principals.upsert({ id: 'liam', name: 'Liam', role: 'child', bindings: [], grants: {} });
  const approvals = new Approvals(dataDir, ledger, principals, {
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
  return { dataDir, ledger, principals, approvals };
}

const who = (principals: Principals, id: string): Principal => {
  const p = principals.get(id);
  assert.ok(p, `missing principal ${id}`);
  return p;
};

function pending(
  approvals: Approvals,
  over: Partial<Parameters<Approvals['request']>[0]> = {},
): ApprovalRequest {
  const result = approvals.request({
    class: 'pay',
    summary: 'Pay $84.20 at Coles',
    principal: 'mag',
    sessionKey: 'discord:123',
    channel: 'discord',
    ...over,
  });
  assert.equal(result.policy, 'confirm');
  assert.ok(result.policy === 'confirm');
  return result.approval;
}

// ── Policies ──────────────────────────────────────────────────

test('ships the default policy table and treats unknown classes as auto', () => {
  const { approvals } = build();
  assert.deepEqual(approvals.policies(), {
    pay: 'confirm',
    'send.external': 'confirm',
    delete: 'confirm',
    'network.block.adult': 'confirm',
    'desktop.run': 'confirm',
    credential: 'never',
  });
  assert.deepEqual(approvals.policies(), DEFAULT_POLICIES);
  assert.equal(approvals.policyFor('pay'), 'confirm');
  assert.equal(approvals.policyFor('credential'), 'never');
  assert.equal(approvals.policyFor('grocery.list.add'), 'auto');
});

test('an auto class needs no approval and writes no ledger line', () => {
  const { approvals, ledger } = build();
  const result = approvals.request({
    class: 'grocery.list.add',
    summary: 'Add milk to the list',
    principal: 'mag',
  });
  assert.deepEqual(result, { policy: 'auto' });
  assert.equal(ledger.list().length, 0);
  assert.deepEqual(approvals.listPending(), []);
});

test('a never class refuses with a reason naming the class', () => {
  const { approvals } = build();
  const result = approvals.request({
    class: 'credential',
    summary: 'Enter the card CVV',
    principal: 'owner',
  });
  assert.equal(result.policy, 'never');
  assert.ok(result.policy === 'never');
  assert.match(result.reason, /credential/);
  assert.match(result.reason, /never/);
  assert.deepEqual(approvals.listPending(), []);
});

test('a never refusal is written to the ledger as denied', () => {
  const { approvals, ledger } = build();
  approvals.request({
    class: 'credential',
    summary: 'Enter the card CVV',
    params: { field: 'cvv' },
    principal: 'liam',
  });
  const entries = ledger.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor, 'system');
  assert.equal(entries[0].principal, 'liam');
  assert.equal(entries[0].action, 'approval.credential');
  assert.equal(entries[0].outcome, 'denied');
  assert.equal(entries[0].error, 'policy never');
  assert.equal(entries[0].target, 'Enter the card CVV');
  assert.deepEqual(entries[0].params, { field: 'cvv' });
  // Nothing to decide: a refusal is final, not a request.
  assert.equal(entries[0].approvalId, undefined);
  assert.deepEqual(approvals.listPending(), []);
});

test('a never refusal honours an explicit action name', () => {
  const { approvals, ledger } = build();
  approvals.request({
    class: 'credential',
    summary: 'Type the one-time code',
    principal: 'owner',
    action: 'email.otp.read',
  });
  assert.equal(ledger.list()[0].action, 'email.otp.read');
});

test('setPolicy changes a class and survives a restart', () => {
  const { approvals, dataDir } = build();
  approvals.setPolicy('pay', 'auto');
  approvals.setPolicy('grocery.buy', 'confirm');
  assert.equal(approvals.policyFor('pay'), 'auto');
  assert.deepEqual(approvals.request({ class: 'pay', summary: 'Pay', principal: 'mag' }), { policy: 'auto' });

  const again = build({ dataDir }).approvals;
  assert.equal(again.policyFor('pay'), 'auto');
  assert.equal(again.policyFor('grocery.buy'), 'confirm');
  assert.equal(again.policyFor('credential'), 'never');
});

// ── Requesting ────────────────────────────────────────────────

test('a confirm class creates a pending request and a pending ledger line', () => {
  const c = clock();
  const { approvals, ledger } = build({ now: c.now });
  const req = pending(approvals);

  assert.equal(req.status, 'pending');
  assert.equal(req.class, 'pay');
  assert.equal(req.principal, 'mag');
  assert.equal(req.sessionKey, 'discord:123');
  assert.equal(req.channel, 'discord');
  assert.equal(req.createdAt, '2026-09-27T09:00:00.000Z');
  // 30 minutes by default.
  assert.equal(req.expiresAt, '2026-09-27T09:30:00.000Z');
  assert.deepEqual(approvals.listPending().map(r => r.id), [req.id]);

  const entry = ledger.get(req.ledgerId);
  assert.ok(entry);
  assert.equal(entry.actor, 'system');
  assert.equal(entry.principal, 'mag');
  assert.equal(entry.action, 'approval.pay');
  assert.equal(entry.outcome, 'pending');
  assert.equal(entry.approvalId, req.id);
});

test('an explicit action names the ledger line instead of the class', () => {
  const { approvals, ledger } = build();
  const req = pending(approvals, { action: 'grocery.order.pay' });
  assert.equal(ledger.get(req.ledgerId)?.action, 'grocery.order.pay');
});

// ── Deciding ──────────────────────────────────────────────────

test('the owner approves, flipping the request and the ledger line', () => {
  const c = clock();
  const { approvals, ledger, principals } = build({ now: c.now });
  const req = pending(approvals);
  c.advance(5_000);

  const decided = approvals.decide(req.id, who(principals, 'owner'), 'approved');
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decidedBy, 'owner');
  assert.equal(decided.decidedAt, '2026-09-27T09:00:05.000Z');
  assert.equal(ledger.get(req.ledgerId)?.outcome, 'ok');
  assert.deepEqual(approvals.listPending(), []);
  assert.equal(approvals.get(req.id)?.status, 'approved');
});

test('a child cannot approve, but the requester can deny their own request', () => {
  const { approvals, ledger, principals } = build();
  const req = pending(approvals);

  assert.throws(
    () => approvals.decide(req.id, who(principals, 'liam'), 'approved'),
    /may not approve/,
  );
  assert.equal(approvals.get(req.id)?.status, 'pending');

  const denied = approvals.decide(req.id, who(principals, 'mag'), 'denied');
  assert.equal(denied.status, 'denied');
  assert.equal(denied.decidedBy, 'mag');
  assert.equal(ledger.get(req.ledgerId)?.outcome, 'denied');
});

test("an adult approves their own request but not anyone else's", () => {
  const { approvals, principals } = build();
  const mine = pending(approvals, { principal: 'mag' });
  assert.equal(approvals.decide(mine.id, who(principals, 'mag'), 'approved').status, 'approved');

  const theirs = pending(approvals, { principal: 'liam' });
  assert.throws(() => approvals.decide(theirs.id, who(principals, 'mag'), 'approved'), /may not approve/);
});

test('a stale principal object cannot decide after being demoted', () => {
  const { approvals, principals } = build();
  const stale = who(principals, 'mag');
  principals.upsert({ ...stale, role: 'child' });
  const req = pending(approvals, { principal: 'owner' });
  assert.throws(() => approvals.decide(req.id, stale, 'approved'), /may not approve/);
});

test('approving twice is idempotent and does not move the decision', () => {
  const c = clock();
  const { approvals, principals } = build({ now: c.now });
  const req = pending(approvals);
  const first = approvals.decide(req.id, who(principals, 'owner'), 'approved');
  c.advance(60_000);
  const second = approvals.decide(req.id, who(principals, 'mag'), 'approved');
  assert.equal(second.status, 'approved');
  assert.equal(second.decidedAt, first.decidedAt);
  assert.equal(second.decidedBy, 'owner');
});

test('approving after a denial throws, and an unknown id throws', () => {
  const { approvals, principals } = build();
  const req = pending(approvals);
  approvals.decide(req.id, who(principals, 'owner'), 'denied');
  assert.throws(() => approvals.decide(req.id, who(principals, 'owner'), 'approved'), /already denied/);
  assert.throws(() => approvals.decide('nope', who(principals, 'owner'), 'approved'), /unknown approval/);
});

test('a request emits approval:requested and a decision emits approval:decided', () => {
  const { approvals, principals } = build();
  const seen: string[] = [];
  approvals.on('approval:requested', (r: ApprovalRequest) => seen.push(`requested:${r.id}`));
  approvals.on('approval:decided', (r: ApprovalRequest) => seen.push(`decided:${r.id}:${r.status}`));
  const req = pending(approvals);
  approvals.decide(req.id, who(principals, 'owner'), 'approved');
  assert.deepEqual(seen, [`requested:${req.id}`, `decided:${req.id}:approved`]);
});

// ── Expiry ────────────────────────────────────────────────────

test('expireDue marks requests past expiresAt and expires the ledger line', () => {
  const c = clock();
  const { approvals, ledger } = build({ now: c.now });
  const req = pending(approvals);
  assert.equal(approvals.expireDue(), 0);

  c.advance(30 * 60_000 + 1);
  assert.equal(approvals.expireDue(), 1);
  assert.equal(approvals.expireDue(), 0);
  assert.equal(approvals.get(req.id)?.status, 'expired');
  assert.equal(ledger.get(req.ledgerId)?.outcome, 'expired');
  assert.deepEqual(approvals.listPending(), []);
});

test('reads expire due requests so a caller never sees a stale pending', () => {
  const c = clock();
  const { approvals } = build({ now: c.now, ttlMs: 1_000 });
  const req = pending(approvals);
  c.advance(2_000);
  assert.equal(approvals.get(req.id)?.status, 'expired');
  assert.deepEqual(approvals.listPending(), []);
});

test('deciding an expired request throws', () => {
  const c = clock();
  const { approvals, principals } = build({ now: c.now, ttlMs: 1_000 });
  const req = pending(approvals);
  c.advance(2_000);
  assert.throws(() => approvals.decide(req.id, who(principals, 'owner'), 'approved'), /already expired/);
});

// ── Waiting ───────────────────────────────────────────────────

test('wait resolves as soon as the decision lands', async () => {
  const { approvals, principals } = build();
  const req = pending(approvals);
  const timer = setTimeout(() => approvals.decide(req.id, who(principals, 'owner'), 'approved'), 10);
  const settled = await approvals.wait(req.id, 5_000);
  clearTimeout(timer);
  assert.equal(settled.status, 'approved');
  assert.equal(settled.id, req.id);
});

test('wait resolves when the request expires', async () => {
  const c = clock();
  const { approvals } = build({ now: c.now, ttlMs: 60_000 });
  const req = pending(approvals);
  const timer = setTimeout(() => { c.advance(120_000); approvals.expireDue(); }, 10);
  const settled = await approvals.wait(req.id, 5_000);
  clearTimeout(timer);
  assert.equal(settled.status, 'expired');
});

test('wait returns the pending request on timeout', async () => {
  const { approvals } = build();
  const req = pending(approvals);
  const started = Date.now();
  const settled = await approvals.wait(req.id, 25);
  assert.equal(settled.status, 'pending');
  assert.equal(settled.id, req.id);
  assert.ok(Date.now() - started < 2_000);
});

test('wait on an already decided request returns immediately', async () => {
  const { approvals, principals } = build();
  const req = pending(approvals);
  approvals.decide(req.id, who(principals, 'owner'), 'denied');
  const settled = await approvals.wait(req.id, 30_000);
  assert.equal(settled.status, 'denied');
});

test('wait on an unknown id rejects', async () => {
  const { approvals } = build();
  await assert.rejects(() => approvals.wait('nope', 10), /unknown approval/);
});

// ── Persistence ───────────────────────────────────────────────

test('requests and decisions survive a restart', () => {
  const { approvals, dataDir, principals } = build();
  const req = pending(approvals);
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'approvals.json'), 'utf-8'));
  assert.equal(onDisk.requests.length, 1);
  assert.ok(onDisk.policies);

  const reopened = build({ dataDir }).approvals;
  assert.deepEqual(reopened.listPending().map(r => r.id), [req.id]);
  reopened.decide(req.id, who(principals, 'owner'), 'approved');

  const third = build({ dataDir }).approvals;
  assert.equal(third.get(req.id)?.status, 'approved');
  assert.deepEqual(third.listPending(), []);
});

test('a corrupt approvals.json still boots with the default policies', () => {
  const d = dir();
  writeFileSync(join(d, 'approvals.json'), '{ not json');
  const { approvals } = build({ dataDir: d });
  assert.equal(approvals.policyFor('pay'), 'confirm');
  assert.deepEqual(approvals.listPending(), []);
});

// ── Id prefix matching (used by /approve and /deny) ────────────

test('matchApprovalId accepts a full id and a unique prefix of six or more', () => {
  const ids = ['1234abcd-1111-2222-3333-444455556666', 'ffff0000-1111-2222-3333-444455556666'];
  assert.deepEqual(matchApprovalId(ids[0], ids), { ok: true, id: ids[0] });
  assert.deepEqual(matchApprovalId('1234ab', ids), { ok: true, id: ids[0] });
  assert.deepEqual(matchApprovalId('FFFF00', ids), { ok: true, id: ids[1] });
});

test('matchApprovalId refuses a short prefix, an unknown one, and an ambiguous one', () => {
  const ids = ['aaaaaa11-0000-0000-0000-000000000000', 'aaaaaa22-0000-0000-0000-000000000000'];
  assert.deepEqual(matchApprovalId('aaa', ids), { ok: false, reason: 'short' });
  assert.deepEqual(matchApprovalId('bbbbbb', ids), { ok: false, reason: 'unknown' });
  assert.deepEqual(matchApprovalId('aaaaaa', ids), { ok: false, reason: 'ambiguous', candidates: ids });
  assert.deepEqual(matchApprovalId('', ids), { ok: false, reason: 'short' });
});
