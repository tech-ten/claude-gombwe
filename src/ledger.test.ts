import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-ledger-'));

test('record appends a line and list returns newest first', () => {
  const d = dir(); const l = new Ledger(d);
  const a = l.record({ actor: 'chat', principal: 'tendai', action: 'family.grocery.add', outcome: 'ok' });
  const b = l.record({ actor: 'cron', principal: 'system', action: 'reflection.run', outcome: 'ok' });
  const lines = readFileSync(join(d, 'ledger.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(l.list().map(e => e.id), [b.id, a.id]);
});

test('update appends a superseding line and list folds by id', () => {
  const d = dir(); const l = new Ledger(d);
  const e = l.record({ actor: 'script', principal: 'tendai', action: 'grocery.checkout', outcome: 'pending' });
  l.update(e.id, { outcome: 'ok', receipt: { order: '123', total: 84.2 } });
  const all = l.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].outcome, 'ok');
  assert.equal(all[0].receipt?.order, '123');
  assert.equal(readFileSync(join(d, 'ledger.jsonl'), 'utf-8').trim().split('\n').length, 2);
});

test('update returns undefined for an unknown id and writes nothing', () => {
  const d = dir(); const l = new Ledger(d);
  assert.equal(l.update('nope', { outcome: 'ok' }), undefined);
  assert.equal(existsSync(join(d, 'ledger.jsonl')), false);
});

test('get returns the folded entry', () => {
  const d = dir(); const l = new Ledger(d);
  const e = l.record({ actor: 'task', principal: 'tendai', action: 'mail.send', outcome: 'pending' });
  l.update(e.id, { outcome: 'failed', error: 'smtp refused' });
  assert.equal(l.get(e.id)?.outcome, 'failed');
  assert.equal(l.get(e.id)?.error, 'smtp refused');
  assert.equal(l.get('missing'), undefined);
});

test('list filters by actor, action prefix, outcome, since, limit', () => {
  const d = dir(); const l = new Ledger(d);
  l.record({ actor: 'chat', principal: 'mag', action: 'family.meal.set', outcome: 'ok', time: '2026-09-01T00:00:00Z' });
  l.record({ actor: 'dashboard', principal: 'tendai', action: 'network.device.block', outcome: 'denied', time: '2026-09-20T00:00:00Z' });
  l.record({ actor: 'dashboard', principal: 'tendai', action: 'network.device.unblock', outcome: 'ok', time: '2026-09-21T00:00:00Z' });
  assert.equal(l.list({ actor: 'dashboard' }).length, 2);
  assert.equal(l.list({ action: 'network.' }).length, 2);
  assert.equal(l.list({ outcome: 'denied' }).length, 1);
  assert.equal(l.list({ since: '2026-09-15T00:00:00Z' }).length, 2);
  assert.equal(l.list({ limit: 1 }).length, 1);
  assert.equal(l.list({ principal: 'mag' }).length, 1);
});

test('reloads from disk on construction', () => {
  const d = dir();
  new Ledger(d).record({ actor: 'chat', principal: 'tendai', action: 'x', outcome: 'ok' });
  assert.equal(new Ledger(d).list().length, 1);
});

test('reloaded entries keep their folded state and stay updatable', () => {
  const d = dir();
  const first = new Ledger(d);
  const e = first.record({ actor: 'script', principal: 'tendai', action: 'grocery.checkout', outcome: 'pending' });
  first.update(e.id, { outcome: 'ok', receipt: { order: '99' } });

  const second = new Ledger(d);
  assert.equal(second.list().length, 1);
  assert.equal(second.get(e.id)?.receipt?.order, '99');
  second.update(e.id, { error: 'late refund' });
  assert.equal(new Ledger(d).get(e.id)?.error, 'late refund');
});

test('rotates when file exceeds rotateBytes', () => {
  const d = dir(); const l = new Ledger(d, { rotateBytes: 300 });
  for (let i = 0; i < 10; i++) l.record({ actor: 'chat', principal: 'tendai', action: 'a'.repeat(50), outcome: 'ok' });
  const rotated = existsSync(join(d, 'ledger.jsonl')) && readdirSync(d).some((f: string) => /^ledger-\d{8}T\d{6}\.jsonl$/.test(f));
  assert.ok(rotated);
  assert.ok(l.list().length >= 1);
});

test('after rotation a new Ledger still sees the previous file', () => {
  const d = dir(); const l = new Ledger(d, { rotateBytes: 300 });
  const first = l.record({ actor: 'chat', principal: 'tendai', action: 'b'.repeat(50), outcome: 'ok' });
  for (let i = 0; i < 3; i++) l.record({ actor: 'chat', principal: 'tendai', action: 'c'.repeat(50), outcome: 'ok' });
  assert.ok(readdirSync(d).some(f => /^ledger-\d{8}T\d{6}/.test(f)), readdirSync(d).join(','));
  assert.ok(new Ledger(d).get(first.id), 'entry from the rotated file should still be readable');
});
