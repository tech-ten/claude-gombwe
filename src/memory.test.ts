import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, MemoryTombstonedError, mayRead, mayWriteSubject, normalise, parseRememberArgs } from './memory.js';
import type { MemoryRecord } from './memory.js';
import type { Principal } from './permissions.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-memory-'));

/** A clock the tests move by hand, so recency needs no real waiting. */
function clock(start = Date.parse('2026-09-27T09:00:00.000Z')) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
  };
}

const chat = (over: Partial<{ channel: string; sessionKey: string; timestamp: string }> = {}) => ({
  channel: 'discord',
  sessionKey: 'discord:123',
  timestamp: '2026-09-27T09:00:00.000Z',
  ...over,
});

const who = (over: Partial<Principal> = {}): Principal => ({
  id: 'tendai',
  name: 'Tendai',
  role: 'adult',
  bindings: [],
  grants: {},
  ...over,
});

const owner = who({ id: 'owner', name: 'Owner', role: 'owner' });
const guest = who({ id: 'guest:web:lan:192.168.1.50', name: 'lan', role: 'guest' });

// ── normalise ─────────────────────────────────────────────────

test('normalise lowercases, collapses whitespace and strips trailing punctuation', () => {
  assert.equal(normalise('  Liam   is   ALLERGIC to peanuts!! '), 'liam is allergic to peanuts');
  assert.equal(normalise('No screens after 9pm.'), 'no screens after 9pm');
  assert.equal(normalise('Who? What...'), 'who? what');
});

// ── remember / list ───────────────────────────────────────────

test('remember then list returns the record', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Liam is allergic to peanuts', 'household', 'fact', chat());
  assert.equal(saved.text, 'Liam is allergic to peanuts');
  assert.equal(saved.subject, 'household');
  assert.equal(saved.kind, 'fact');
  assert.equal(saved.useCount, 0);
  assert.equal(saved.forgotten, false);
  assert.ok(saved.id);

  const all = memory.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, saved.id);
});

test('list filters by subject and kind, and hides forgotten records', () => {
  const memory = new Memory(dir());
  memory.remember('No screens after 9pm', 'liam', 'instruction', chat());
  memory.remember('Prefers oat milk', 'tendai', 'preference', chat());
  const gone = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(gone.id);

  assert.deepEqual(memory.list({ subject: 'liam' }).map(r => r.subject), ['liam']);
  assert.deepEqual(memory.list({ kind: 'preference' }).map(r => r.text), ['Prefers oat milk']);
  assert.equal(memory.list().length, 2);
  assert.equal(memory.list({ includeForgotten: true }).length, 3);
});

test('remembering the same normalised text and subject updates rather than inserts', () => {
  const c = clock();
  const memory = new Memory(dir(), { now: c.now });
  const first = memory.remember('No screens  after 9pm', 'liam', 'instruction', chat());
  c.advance(60_000);
  const second = memory.remember('No screens after 9pm.', 'liam', 'preference', { manual: 'dashboard' });

  assert.equal(second.id, first.id);
  assert.equal(memory.list().length, 1);
  assert.equal(second.kind, 'preference', 'the newer kind wins');
  assert.equal(second.createdAt, first.createdAt);
  assert.ok(second.updatedAt > first.updatedAt, 'updatedAt moves forward');
});

test('the same text for a different subject is a separate record', () => {
  const memory = new Memory(dir());
  memory.remember('No screens after 9pm', 'liam', 'instruction', chat());
  memory.remember('No screens after 9pm', 'household', 'instruction', chat());
  assert.equal(memory.list().length, 2);
});

// ── recall ────────────────────────────────────────────────────

test('recall ranks the record matching more query terms first and bumps useCount', () => {
  const memory = new Memory(dir());
  memory.remember('Liam is allergic to peanuts', 'household', 'fact', chat());
  memory.remember('Liam plays soccer on Saturdays', 'household', 'fact', chat());
  memory.remember('Bin night is Tuesday', 'household', 'fact', chat());

  const hits = memory.recall('what is Liam allergic to');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].text, 'Liam is allergic to peanuts');
  assert.equal(hits[0].useCount, 1, 'returned records are bumped');
  assert.ok(hits[0].lastUsedAt);

  // The bump is persisted, not just returned.
  assert.equal(memory.list().find(r => r.text === hits[0].text)?.useCount, 1);
  assert.equal(memory.list().find(r => r.text === 'Bin night is Tuesday')?.useCount, 0);
});

test('recall drops records matching nothing, honours limit, subject and kind', () => {
  const memory = new Memory(dir());
  memory.remember('Prefers oat milk', 'tendai', 'preference', chat());
  memory.remember('Oat porridge for breakfast', 'liam', 'instruction', chat());

  assert.deepEqual(memory.recall('bicycle repair').map(r => r.text), []);
  assert.equal(memory.recall('oat').length, 2);
  assert.equal(memory.recall('oat', { limit: 1 }).length, 1);
  assert.deepEqual(memory.recall('oat', { subject: 'tendai' }).map(r => r.subject), ['tendai']);
  assert.deepEqual(memory.recall('oat', { kind: 'instruction' }).map(r => r.kind), ['instruction']);
});

test('recall ignores query terms shorter than three characters', () => {
  const memory = new Memory(dir());
  memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  assert.deepEqual(memory.recall('is a to').map(r => r.text), []);
});

test('recall matches the subject as well as the text', () => {
  const memory = new Memory(dir());
  memory.remember('Bedtime is 8pm', 'liam', 'instruction', chat());
  assert.equal(memory.recall('liam').length, 1);
});

test('recall skips forgotten records', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);
  assert.deepEqual(memory.recall('bin night'), []);
});

test('recall breaks a tie on use count, then on recency', () => {
  const c = clock();
  const memory = new Memory(dir(), { now: c.now });
  const older = memory.remember('peanuts are banned', 'household', 'fact', chat());
  c.advance(40 * 86_400_000);
  memory.remember('peanuts are everywhere', 'household', 'fact', chat());

  // Recency alone favours the newer record.
  assert.equal(memory.recall('peanuts')[0].text, 'peanuts are everywhere');

  // Use count outweighs it.
  for (let i = 0; i < 5; i++) memory.recall('banned');
  assert.equal(memory.list().find(r => r.id === older.id)?.useCount, 6);
  assert.equal(memory.recall('peanuts')[0].text, 'peanuts are banned');
});

// ── forget and tombstones ─────────────────────────────────────

test('forget marks the record and writes a tombstone, by id or by text', () => {
  const memory = new Memory(dir());
  const byId = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.remember('Prefers oat milk', 'tendai', 'preference', chat());

  const forgotten = memory.forget(byId.id);
  assert.equal(forgotten?.id, byId.id);
  assert.equal(forgotten?.forgotten, true);
  assert.equal(memory.isTombstoned('bin  night is tuesday.', 'household'), true);
  assert.equal(memory.isTombstoned('Bin night is Tuesday', 'tendai'), false, 'tombstones are per subject');

  const byText = memory.forget('prefers OAT milk');
  assert.equal(byText?.subject, 'tendai');
  assert.equal(memory.isTombstoned('Prefers oat milk', 'tendai'), true);

  assert.equal(memory.forget('never said this'), undefined);
});

test('a reflection cannot re-remember tombstoned text', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);

  assert.throws(
    () => memory.remember('bin night is tuesday', 'household', 'fact', { reflection: 'nightly' }),
    (err: unknown) => err instanceof MemoryTombstonedError,
  );
  assert.equal(memory.list().length, 0);
  assert.equal(memory.isTombstoned('Bin night is Tuesday', 'household'), true);
});

test('a person can re-remember tombstoned text, which clears the tombstone', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);

  const again = memory.remember('Bin night is Tuesday', 'household', 'fact', { manual: 'dashboard' });
  assert.equal(again.forgotten, false);
  assert.equal(memory.isTombstoned('Bin night is Tuesday', 'household'), false);
  assert.equal(memory.list().length, 1);

  // And a reflection may say it again now that a human did.
  const third = memory.remember('bin night is tuesday', 'household', 'fact', { reflection: 'nightly' });
  assert.equal(third.id, again.id);
});

test('a chat source also clears a tombstone', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);
  const again = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  assert.equal(again.forgotten, false);
  assert.equal(memory.isTombstoned('Bin night is Tuesday', 'household'), false);
});

// ── updatedAt high-water mark ─────────────────────────────────

test('updatedAt is the newest change, empty when there is nothing', () => {
  const c = clock();
  const memory = new Memory(dir(), { now: c.now });
  assert.equal(memory.updatedAt(), '');

  const first = memory.remember('Prefers oat milk', 'tendai', 'preference', chat());
  assert.equal(memory.updatedAt(), first.updatedAt);

  c.advance(60_000);
  const second = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  assert.equal(memory.updatedAt(), second.updatedAt);

  // Forgetting is a change too, so a session's stamp goes stale.
  c.advance(60_000);
  memory.forget(second.id);
  assert.ok(memory.updatedAt() > second.updatedAt);

  // Recall bumps use counts, which is not a change to what is remembered.
  const stamp = memory.updatedAt();
  c.advance(60_000);
  memory.recall('oat milk');
  assert.equal(memory.updatedAt(), stamp);
});

// ── contextBlock ──────────────────────────────────────────────

test('contextBlock is empty when there is nothing to say', () => {
  const memory = new Memory(dir());
  assert.equal(memory.contextBlock(owner), '');
});

test('contextBlock orders by kind then recency and ends with the tool instruction', () => {
  const c = clock();
  const memory = new Memory(dir(), { now: c.now });
  memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  c.advance(60_000);
  memory.remember('Buy a new router this year', 'household', 'goal', chat());
  c.advance(60_000);
  memory.remember('Mag is my wife', 'household', 'relationship', chat());
  c.advance(60_000);
  memory.remember('Prefers oat milk', 'household', 'preference', chat());
  c.advance(60_000);
  memory.remember('No screens after 9pm', 'household', 'instruction', chat());
  c.advance(60_000);
  memory.remember('Always reply in short sentences', 'household', 'instruction', chat());

  const block = memory.contextBlock(owner);
  const lines = block.split('\n');
  assert.equal(lines[0], '<household-memory>');
  assert.deepEqual(lines.slice(1, 7), [
    '- [instruction|household] Always reply in short sentences',
    '- [instruction|household] No screens after 9pm',
    '- [preference|household] Prefers oat milk',
    '- [relationship|household] Mag is my wife',
    '- [fact|household] Bin night is Tuesday',
    '- [goal|household] Buy a new router this year',
  ]);
  assert.equal(
    lines[7],
    'Use memory_remember for preferences, standing instructions, facts about people and goals; ' +
    'memory_forget when asked to forget.',
  );
  assert.equal(lines[8], '</household-memory>');
  assert.equal(lines.length, 9);
});

test('contextBlock stops adding lines at the budget', () => {
  const c = clock();
  const memory = new Memory(dir(), { now: c.now });
  memory.remember('No screens after 9pm', 'household', 'instruction', chat());
  c.advance(60_000);
  memory.remember('Always reply in short sentences', 'household', 'instruction', chat());

  const block = memory.contextBlock(owner, 60);
  assert.ok(block.includes('- [instruction|household] Always reply in short sentences'));
  assert.ok(!block.includes('No screens after 9pm'), 'the second line does not fit');
  // The wrapper and the instruction line are still there.
  assert.ok(block.startsWith('<household-memory>\n'));
  assert.ok(block.includes('memory_forget when asked to forget.'));
  assert.ok(block.endsWith('\n</household-memory>'));
});

test('contextBlock shows an adult their own memories and the household ones only', () => {
  const memory = new Memory(dir());
  memory.remember('Prefers oat milk', 'tendai', 'preference', chat());
  memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.remember('Bedtime is 8pm', 'liam', 'instruction', chat());

  const mine = memory.contextBlock(who());
  assert.ok(mine.includes('Prefers oat milk'));
  assert.ok(mine.includes('Bin night is Tuesday'));
  assert.ok(!mine.includes('Bedtime is 8pm'), "another person's memories are not shown");

  const all = memory.contextBlock(owner);
  assert.ok(all.includes('Prefers oat milk'));
  assert.ok(all.includes('Bedtime is 8pm'));
  assert.ok(all.includes('Bin night is Tuesday'));
});

test('contextBlock shows a guest household memories only', () => {
  const memory = new Memory(dir());
  memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.remember('Prefers oat milk', guest.id, 'preference', chat());

  const block = memory.contextBlock(guest);
  assert.ok(block.includes('Bin night is Tuesday'));
  assert.ok(!block.includes('Prefers oat milk'));
});

test('contextBlock leaves out forgotten records', () => {
  const memory = new Memory(dir());
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);
  assert.equal(memory.contextBlock(owner), '');
});

// ── persistence ───────────────────────────────────────────────

test('records, use counts and tombstones survive a reload', () => {
  const dataDir = dir();
  const first = new Memory(dataDir);
  const kept = first.remember('Prefers oat milk', 'tendai', 'preference', chat());
  const dropped = first.remember('Bin night is Tuesday', 'household', 'fact', chat());
  first.forget(dropped.id);
  first.recall('oat milk');

  assert.ok(existsSync(join(dataDir, 'memory.json')));
  assert.ok(existsSync(join(dataDir, 'tombstones.json')));

  const reloaded = new Memory(dataDir);
  assert.deepEqual(reloaded.list().map(r => r.id), [kept.id]);
  assert.equal(reloaded.list()[0].useCount, 1);
  assert.equal(reloaded.list({ includeForgotten: true }).length, 2);
  assert.equal(reloaded.isTombstoned('Bin night is Tuesday', 'household'), true);
  assert.equal(reloaded.updatedAt(), first.updatedAt());
});

test('a tombstone records the hash, subject, source and time', () => {
  const dataDir = dir();
  const memory = new Memory(dataDir);
  const saved = memory.remember('Bin night is Tuesday', 'household', 'fact', chat());
  memory.forget(saved.id);

  const parsed = JSON.parse(readFileSync(join(dataDir, 'tombstones.json'), 'utf-8'));
  assert.equal(parsed.tombstones.length, 1);
  const [stone] = parsed.tombstones;
  assert.match(stone.hash, /^[0-9a-f]{40}$/);
  assert.equal(stone.subject, 'household');
  assert.deepEqual(stone.source, chat());
  assert.ok(stone.at);
});

test('a half-written or hand-edited store does not stop the gateway booting', () => {
  const dataDir = dir();
  writeFileSync(join(dataDir, 'memory.json'), '{ not json');
  writeFileSync(join(dataDir, 'tombstones.json'), '{ not json either');
  const memory = new Memory(dataDir);
  assert.deepEqual(memory.list(), []);
  assert.equal(memory.remember('Prefers oat milk', 'tendai', 'preference', chat()).useCount, 0);
});

// ── /remember arguments ───────────────────────────────────────

test('parseRememberArgs files a plain sentence under the speaker as a fact', () => {
  assert.deepEqual(parseRememberArgs('I prefer oat milk', 'tendai'), {
    text: 'I prefer oat milk', subject: 'tendai', kind: 'fact',
  });
});

test('parseRememberArgs reads the household and kind prefixes, in either order', () => {
  assert.deepEqual(parseRememberArgs('household: Bin night is Tuesday', 'tendai'), {
    text: 'Bin night is Tuesday', subject: 'household', kind: 'fact',
  });
  assert.deepEqual(parseRememberArgs('household: instruction: No screens after 9pm', 'tendai'), {
    text: 'No screens after 9pm', subject: 'household', kind: 'instruction',
  });
  assert.deepEqual(parseRememberArgs('preference: household: oat milk only', 'tendai'), {
    text: 'oat milk only', subject: 'household', kind: 'preference',
  });
});

test('parseRememberArgs leaves a sentence that merely contains a colon alone', () => {
  assert.deepEqual(parseRememberArgs('note: the bin is out', 'tendai'), {
    text: 'note: the bin is out', subject: 'tendai', kind: 'fact',
  });
  assert.equal(parseRememberArgs('   ', 'tendai'), undefined);
  assert.equal(parseRememberArgs('household:', 'tendai'), undefined);
});

// ── who may see what ──────────────────────────────────────────

test('mayRead and mayWriteSubject: own subject and household, all of it for an owner', () => {
  const record = (subject: string) => ({ subject } as MemoryRecord);

  assert.equal(mayRead(who(), record('tendai')), true);
  assert.equal(mayRead(who(), record('household')), true);
  assert.equal(mayRead(who(), record('liam')), false);
  assert.equal(mayRead(owner, record('liam')), true);
  assert.equal(mayRead(guest, record('household')), true);
  assert.equal(mayRead(guest, record(guest.id)), false);

  assert.equal(mayWriteSubject(who(), 'tendai'), true);
  assert.equal(mayWriteSubject(who(), 'household'), true);
  assert.equal(mayWriteSubject(who(), 'liam'), false);
  assert.equal(mayWriteSubject(owner, 'liam'), true);
  assert.equal(mayWriteSubject(guest, guest.id), false);
});
