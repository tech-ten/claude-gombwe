import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_WAIT_MS,
  callTool,
  listToolsFor,
  pendingApprovalResult,
  toolManifestFor,
  tools,
} from './gombwe-tools.js';
import type { ToolContext } from './gombwe-tools.js';
import { Approvals } from './approvals.js';
import { Ledger } from './ledger.js';
import { Memory } from './memory.js';
import { Principals } from './permissions.js';
import type { Principal } from './permissions.js';
import type { Services } from './services.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-tools-'));

function build() {
  const dataDir = dir();
  const ledger = new Ledger(dataDir);
  const principals = new Principals(dataDir);
  // A child who may read memory but not write it, and an adult who may do both.
  principals.upsert({ id: 'liam', name: 'Liam', role: 'child', bindings: [], grants: { memory: 'read' } });
  principals.upsert({ id: 'kai', name: 'Kai', role: 'child', bindings: [], grants: {} });
  principals.upsert({ id: 'mag', name: 'Mag', role: 'adult', bindings: [], grants: { memory: 'act', family: 'read' } });
  const approvals = new Approvals(dataDir, ledger, principals);
  const memory = new Memory(dataDir);
  const services: Services = { ledger, principals, approvals, memory };
  return { dataDir, ledger, principals, approvals, memory, services };
}

const who = (principals: Principals, id: string): Principal => {
  const p = principals.get(id);
  assert.ok(p, `missing principal ${id}`);
  return p;
};

function ctxFor(services: Services, principal: Principal, over: Partial<ToolContext> = {}): ToolContext {
  return {
    services,
    principal,
    actor: 'chat',
    sessionKey: 'web:test',
    channel: 'web',
    ...over,
  };
}

// ── The registry ──────────────────────────────────────────────

test('every tool has a name, a description and a schema', () => {
  assert.ok(tools.length >= 7);
  const names = tools.map(t => t.name);
  for (const expected of [
    'memory_remember', 'memory_recall', 'memory_forget',
    'approval_request', 'approval_status',
    'ledger_record', 'ledger_recent',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
  for (const t of tools) {
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(typeof t.inputSchema.parse, 'function');
  }
});

test('listToolsFor excludes memory tools when the principal has no memory grant', () => {
  const { principals } = build();
  const names = listToolsFor(who(principals, 'kai')).map(t => t.name);
  assert.ok(!names.some(n => n.startsWith('memory_')), `memory tools leaked: ${names.join(', ')}`);
  // Approvals and the ledger are not behind a connector grant: anyone may ask
  // for consent, and anyone may record what they did.
  assert.ok(names.includes('approval_request'));
  assert.ok(names.includes('ledger_recent'));
});

test('listToolsFor gives a read-only grant the read memory tool only', () => {
  const { principals } = build();
  const names = listToolsFor(who(principals, 'liam')).map(t => t.name);
  assert.ok(names.includes('memory_recall'));
  assert.ok(!names.includes('memory_remember'));
  assert.ok(!names.includes('memory_forget'));
});

test('listToolsFor gives the owner everything', () => {
  const { principals } = build();
  const names = listToolsFor(who(principals, 'owner')).map(t => t.name);
  assert.equal(names.length, tools.length);
});

test('toolManifestFor renders JSON Schema for each tool the principal may use', () => {
  const { principals } = build();
  const manifest = toolManifestFor(who(principals, 'owner'));
  assert.equal(manifest.length, tools.length);
  const remember = manifest.find(t => t.name === 'memory_remember');
  assert.ok(remember);
  assert.equal(remember.inputSchema.type, 'object');
  const props = remember.inputSchema.properties as Record<string, unknown>;
  assert.ok(props.text, 'text should be in the JSON Schema');
  assert.ok(props.kind, 'kind should be in the JSON Schema');
  // Must survive JSON.stringify — it goes over HTTP to the stdio server.
  assert.ok(JSON.parse(JSON.stringify(manifest)).length === tools.length);
});

// ── callTool: validation and permission ───────────────────────

test('callTool on an unknown tool fails without touching the ledger', async () => {
  const { services, ledger, principals } = build();
  const result = await callTool('nope_not_a_tool', {}, ctxFor(services, who(principals, 'owner')));
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /unknown tool/i);
  assert.equal(ledger.list().length, 0);
});

test('callTool rejects arguments the schema does not accept', async () => {
  const { services, principals } = build();
  const result = await callTool('memory_remember', { subject: 'household' }, ctxFor(services, who(principals, 'owner')));
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /text/i);
});

test('callTool refuses a child on an act tool and says so', async () => {
  const { services, principals, memory } = build();
  const result = await callTool(
    'memory_remember',
    { text: 'I get unlimited screen time', kind: 'instruction' },
    ctxFor(services, who(principals, 'liam')),
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /may not|permission/i);
  assert.equal(memory.list().length, 0, 'nothing should have been written');
});

test('callTool records a denial in the ledger for an act tool', async () => {
  const { services, principals, ledger } = build();
  await callTool('memory_forget', { idOrText: 'anything' }, ctxFor(services, who(principals, 'liam')));
  const entries = ledger.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'tool.memory_forget');
  assert.equal(entries[0].outcome, 'denied');
  assert.equal(entries[0].principal, 'liam');
});

// ── Memory tools ──────────────────────────────────────────────

test('callTool memory_remember writes a record and a ledger entry', async () => {
  const { services, principals, memory, ledger } = build();
  const result = await callTool(
    'memory_remember',
    { text: 'Liam is allergic to peanuts', subject: 'household', kind: 'fact' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(result.ok, true);
  assert.match((result as { text: string }).text, /peanuts/);

  const saved = memory.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'Liam is allergic to peanuts');
  assert.equal(saved[0].subject, 'household');
  assert.equal(saved[0].kind, 'fact');
  assert.deepEqual(
    { channel: 'web', sessionKey: 'web:test' },
    { channel: (saved[0].source as { channel: string }).channel, sessionKey: (saved[0].source as { sessionKey: string }).sessionKey },
  );

  const entries = ledger.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'tool.memory_remember');
  assert.equal(entries[0].actor, 'chat');
  assert.equal(entries[0].principal, 'mag');
  assert.equal(entries[0].outcome, 'ok');
  assert.equal(entries[0].sessionKey, 'web:test');
  assert.match(String(entries[0].params?.text), /peanuts/);
});

test('memory_remember defaults the subject to the caller and refuses another member', async () => {
  const { services, principals, memory } = build();
  const mine = await callTool(
    'memory_remember',
    { text: 'I like oat milk', kind: 'preference' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(mine.ok, true);
  assert.equal(memory.list()[0].subject, 'mag');

  const theirs = await callTool(
    'memory_remember',
    { text: 'Liam loves homework', subject: 'liam', kind: 'fact' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(theirs.ok, false);
  assert.match((theirs as { error: string }).error, /liam/i);
});

test('memory_recall only returns what the caller may read', async () => {
  const { services, principals, memory } = build();
  memory.remember('Mag prefers oat milk', 'mag', 'preference', { manual: 'test' });
  memory.remember('Bin night is Tuesday', 'household', 'fact', { manual: 'test' });

  const asChild = await callTool('memory_recall', { query: 'milk tuesday bin' }, ctxFor(services, who(principals, 'liam')));
  assert.equal(asChild.ok, true);
  const childHits = (asChild as { data: { records: { text: string }[] } }).data.records;
  assert.deepEqual(childHits.map(r => r.text), ['Bin night is Tuesday']);

  const asMag = await callTool('memory_recall', { query: 'milk tuesday bin' }, ctxFor(services, who(principals, 'mag')));
  const magHits = (asMag as { data: { records: { text: string }[] } }).data.records;
  assert.equal(magHits.length, 2);
});

test('memory_recall is a read, so it writes no ledger entry', async () => {
  const { services, principals, ledger } = build();
  await callTool('memory_recall', { query: 'anything at all' }, ctxFor(services, who(principals, 'owner')));
  assert.equal(ledger.list().length, 0);
});

test('memory_forget tombstones the record', async () => {
  const { services, principals, memory } = build();
  memory.remember('Bin night is Tuesday', 'household', 'fact', { manual: 'test' });
  const result = await callTool('memory_forget', { idOrText: 'Bin night is Tuesday' }, ctxFor(services, who(principals, 'owner')));
  assert.equal(result.ok, true);
  assert.equal(memory.list().length, 0);
  assert.equal(memory.isTombstoned('Bin night is Tuesday', 'household'), true);
});

test('memory_forget on text nobody remembers fails cleanly', async () => {
  const { services, principals, ledger } = build();
  const result = await callTool('memory_forget', { idOrText: 'never said this' }, ctxFor(services, who(principals, 'owner')));
  assert.equal(result.ok, false);
  assert.equal(ledger.list()[0].outcome, 'failed');
});

// ── Approvals ─────────────────────────────────────────────────

test('approval_request on an auto class needs no approval', async () => {
  const { services, principals } = build();
  const result = await callTool(
    'approval_request',
    { class: 'grocery.add', summary: 'add milk to the list' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(result.ok, true);
  assert.equal((result as { data: { status: string } }).data.status, 'auto');
});

test('approval_request on a confirm class waits and returns the decision', async () => {
  const { services, principals, approvals } = build();
  const mag = who(principals, 'mag');
  const owner = who(principals, 'owner');

  const settle = setTimeout(() => {
    const pending = approvals.listPending();
    assert.equal(pending.length, 1, 'the request should be pending while we wait');
    approvals.decide(pending[0].id, owner, 'approved');
  }, 20);
  settle.unref?.();

  const result = await callTool(
    'approval_request',
    { class: 'pay', summary: 'buy the groceries', params: { total: 120 } },
    ctxFor(services, mag),
  );
  assert.equal(result.ok, true);
  const data = (result as { data: { status: string; id: string } }).data;
  assert.equal(data.status, 'approved');
  assert.ok(data.id);
  assert.match((result as { text: string }).text, /approved/i);
});

test('approval_request reports a denial as ok:false', async () => {
  const { services, principals, approvals } = build();
  const owner = who(principals, 'owner');
  const settle = setTimeout(() => {
    const pending = approvals.listPending();
    if (pending.length) approvals.decide(pending[0].id, owner, 'denied');
  }, 20);
  settle.unref?.();

  const result = await callTool(
    'approval_request',
    { class: 'delete', summary: 'delete the holiday photos' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /denied/i);
});

test('approval_request on a never class refuses without waiting', async () => {
  const { services, principals } = build();
  const result = await callTool(
    'approval_request',
    { class: 'credential', summary: 'read the bank password' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /never/i);
});

test('approval_request never blocks longer than 55 seconds', () => {
  assert.equal(APPROVAL_WAIT_MS, 55_000);
  const result = pendingApprovalResult('abcdef1234567890');
  assert.equal(result.ok, true);
  assert.equal((result as { data: { status: string; id: string } }).data.status, 'pending');
  assert.equal((result as { data: { id: string } }).data.id, 'abcdef1234567890');
  const text = (result as { text: string }).text;
  assert.match(text, /abcdef12 is pending/);
  assert.match(text, /end your turn/i);
  assert.match(text, /resumes automatically/i);
});

test('approval_status reports the current state and 404s an unknown id', async () => {
  const { services, principals, approvals } = build();
  const asked = approvals.request({ class: 'pay', summary: 'buy a thing', principal: 'mag' });
  assert.equal(asked.policy, 'confirm');
  const id = asked.policy === 'confirm' ? asked.approval.id : '';

  const pending = await callTool('approval_status', { id }, ctxFor(services, who(principals, 'mag')));
  assert.equal(pending.ok, true);
  assert.equal((pending as { data: { status: string } }).data.status, 'pending');

  approvals.decide(id, who(principals, 'owner'), 'approved');
  const settled = await callTool('approval_status', { id }, ctxFor(services, who(principals, 'mag')));
  assert.equal((settled as { data: { status: string } }).data.status, 'approved');

  const missing = await callTool('approval_status', { id: 'no-such-approval' }, ctxFor(services, who(principals, 'mag')));
  assert.equal(missing.ok, false);
});

// ── Ledger ────────────────────────────────────────────────────

test('ledger_record writes the third-party side effect the agent describes', async () => {
  const { services, principals, ledger } = build();
  const result = await callTool(
    'ledger_record',
    {
      action: 'grocery.order',
      target: 'Woolworths',
      params: { items: 3 },
      receipt: { orderId: 'WW-991' },
      outcome: 'ok',
    },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(result.ok, true);

  const entries = ledger.list();
  // Exactly one line: the tool writes the entry itself, so callTool does not
  // wrap it in a second `tool.ledger_record` line.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'grocery.order');
  assert.equal(entries[0].target, 'Woolworths');
  assert.equal(entries[0].outcome, 'ok');
  assert.equal(entries[0].principal, 'mag');
  assert.equal(entries[0].actor, 'chat');
  assert.deepEqual(entries[0].receipt, { orderId: 'WW-991' });
});

test('ledger_record defaults the outcome to ok and rejects an unknown one', async () => {
  const { services, principals, ledger } = build();
  const ok = await callTool('ledger_record', { action: 'email.sent' }, ctxFor(services, who(principals, 'mag')));
  assert.equal(ok.ok, true);
  assert.equal(ledger.list()[0].outcome, 'ok');

  const bad = await callTool(
    'ledger_record',
    { action: 'email.sent', outcome: 'maybe' },
    ctxFor(services, who(principals, 'mag')),
  );
  assert.equal(bad.ok, false);
});

test('ledger_recent shows the owner everything and a child only their own', async () => {
  const { services, principals, ledger } = build();
  ledger.record({ actor: 'chat', principal: 'mag', action: 'grocery.order', outcome: 'ok' });
  ledger.record({ actor: 'chat', principal: 'liam', action: 'network.device.block', outcome: 'ok' });

  const asOwner = await callTool('ledger_recent', {}, ctxFor(services, who(principals, 'owner')));
  assert.equal((asOwner as { data: { entries: unknown[] } }).data.entries.length, 2);

  const asChild = await callTool('ledger_recent', {}, ctxFor(services, who(principals, 'liam')));
  const mine = (asChild as { data: { entries: { principal: string }[] } }).data.entries;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].principal, 'liam');
});

test('ledger_recent honours a limit and writes nothing itself', async () => {
  const { services, principals, ledger } = build();
  for (let i = 0; i < 5; i++) {
    ledger.record({ actor: 'chat', principal: 'owner', action: `thing.${i}`, outcome: 'ok' });
  }
  const result = await callTool('ledger_recent', { limit: 2 }, ctxFor(services, who(principals, 'owner')));
  assert.equal((result as { data: { entries: unknown[] } }).data.entries.length, 2);
  assert.equal(ledger.list().length, 5);
});
