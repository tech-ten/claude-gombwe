/**
 * Household memory: the handful of things gombwe should still know next week.
 *
 * A record is one sentence about one subject — a person's id, or `household`
 * for everyone. Kinds are narrow on purpose (an instruction, a preference, a
 * relationship, a fact, a goal) so the context block stays short enough to
 * prepend to every conversation.
 *
 * Forgetting is the part that has to hold. `forget()` marks the record and
 * writes a tombstone keyed on the normalised text and subject, and a
 * reflection — gombwe deciding on its own that something is worth keeping —
 * can never write that text back: it throws `MemoryTombstonedError`. A person
 * saying it again is different, so a manual or chat source succeeds and clears
 * the tombstone. Without that asymmetry, "forget my address" would last until
 * the next nightly pass read it out of a transcript again.
 *
 * Records are never deleted, only marked, so a cleared record cannot come back
 * as a duplicate and the file stays a record of what was said.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from './permissions.js';

export type MemoryKind = 'preference' | 'fact' | 'goal' | 'instruction' | 'relationship';

/** Where a record came from: a conversation, a reflection pass, or a person. */
export type MemorySource =
  | { channel: string; sessionKey: string; timestamp: string; quote?: string }
  | { reflection: string }
  | { manual: string };

export interface MemoryRecord {
  id: string;
  text: string;
  /** A principal id, or `household` for something everyone should know. */
  subject: string;
  kind: MemoryKind;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  forgotten: boolean;
}

/** What was forgotten, so a reflection cannot write it back. */
export interface Tombstone {
  /** sha1 of the normalised text and the subject. */
  hash: string;
  subject: string;
  /** The source the forgotten record carried. */
  source: MemorySource;
  at: string;
}

export interface MemoryListOptions {
  subject?: string;
  kind?: MemoryKind;
  includeForgotten?: boolean;
}

export interface MemoryRecallOptions {
  subject?: string;
  kind?: MemoryKind;
  limit?: number;
}

export class MemoryTombstonedError extends Error {
  constructor(readonly subject: string) {
    super(`that was forgotten for ${subject}; only a person can say it again`);
    this.name = 'MemoryTombstonedError';
  }
}

export const MEMORY_KINDS: MemoryKind[] = [
  'preference', 'fact', 'goal', 'instruction', 'relationship',
];

/** The subject everyone in the household can see. */
export const HOUSEHOLD = 'household';

/**
 * Who an unidentified caller is. A guest id resolved off a network address is
 * not in the roster, so a lookup for it comes back undefined — and that must
 * mean "sees only what the household would tell a visitor", not "sees all".
 */
const ANONYMOUS: Principal = {
  id: 'guest', name: 'guest', role: 'guest', bindings: [], grants: {},
};

const FILE = 'memory.json';
const TOMBSTONE_FILE = 'tombstones.json';
const DEFAULT_BUDGET_CHARS = 2000;
const DEFAULT_RECALL_LIMIT = 10;
/** Query terms shorter than this are noise ('is', 'to', 'a'). */
const MIN_TERM = 3;
/** How many days of staleness still count against a record. */
const RECENCY_CAP_DAYS = 30;
/** Per stale day, so recency only ever breaks a tie. */
const RECENCY_WEIGHT = 0.1;
/** Per matched query term — the thing that actually decides the order. */
const TERM_WEIGHT = 10;
/** Most a well-used record can earn for being well used. */
const USE_CAP = 5;

/** Read order: what to do, then what is liked, then who, then what is true. */
const KIND_ORDER: MemoryKind[] = ['instruction', 'preference', 'relationship', 'fact', 'goal'];

/**
 * Where a kind sorts. A kind that is not in the table — a hand-edited file, or
 * a kind added to the type but not to the order — goes last rather than ahead
 * of the standing instructions, which is where a raw `indexOf` of -1 would put
 * it.
 */
function kindRank(kind: MemoryKind): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

const TOOL_HINT =
  'Use memory_remember for preferences, standing instructions, facts about people and goals; ' +
  'memory_forget when asked to forget, or the /remember and /forget commands. ' +
  'A later household-memory block replaces any earlier one in this conversation.';

/**
 * `/remember` arguments: an optional `household:` prefix (the default subject
 * is whoever is speaking) and an optional `<kind>:` prefix. A plain sentence is
 * a fact, which is the safest default — it reads as background rather than as a
 * standing instruction the agent should act on.
 */
export function parseRememberArgs(
  raw: string,
  speaker: string,
): { text: string; subject: string; kind: MemoryKind } | undefined {
  let rest = String(raw ?? '').trim();
  let subject = speaker;
  let kind: MemoryKind = 'fact';
  for (let i = 0; i < 2 && rest; i++) {
    const match = /^([a-z]+):\s*/i.exec(rest);
    if (!match) break;
    const word = match[1].toLowerCase();
    if (word === HOUSEHOLD) subject = HOUSEHOLD;
    else if ((MEMORY_KINDS as string[]).includes(word)) kind = word as MemoryKind;
    else break;
    rest = rest.slice(match[0].length).trim();
  }
  return rest ? { text: rest, subject, kind } : undefined;
}

/**
 * May this principal read this record? The owner sees the whole household's
 * memory; everyone else sees their own and what is held for `household`. A
 * guest — anyone on the network we do not recognise — sees only the household
 * subject, never a record filed under the id their address resolved to.
 *
 * One definition, used by the context block, the chat commands and the API, so
 * a surface added later cannot quietly widen it.
 */
export function mayRead(principal: Principal, record: MemoryRecord): boolean {
  if (principal.role === 'owner') return true;
  if (record.subject === HOUSEHOLD) return true;
  return principal.role !== 'guest' && record.subject === principal.id;
}

/** May this principal file something under this subject? */
export function mayWriteSubject(principal: Principal, subject: string): boolean {
  if (principal.role === 'owner') return true;
  if (subject === HOUSEHOLD) return true;
  return principal.role !== 'guest' && subject === principal.id;
}

/**
 * The comparable form of a sentence: lowercased, one space between words, no
 * trailing punctuation. "No screens after 9pm." and "no screens  after 9pm"
 * are the same standing instruction, so they must not become two records.
 */
export function normalise(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[\s.,;:!?]+$/, '');
}

/** The tombstone key: one sentence, for one subject. */
function hashOf(text: string, subject: string): string {
  return createHash('sha1').update(`${normalise(text)}|${subject}`).digest('hex');
}

/** A reflection is gombwe's own idea; anything else is a person speaking. */
function isReflection(source: MemorySource): boolean {
  return typeof (source as { reflection?: unknown }).reflection === 'string';
}

export class Memory {
  private file: string;
  private tombstoneFile: string;
  private records: MemoryRecord[] = [];
  private tombstones: Tombstone[] = [];
  private now: () => Date;

  constructor(dataDir: string, opts: { now?: () => Date } = {}) {
    this.file = join(dataDir, FILE);
    this.tombstoneFile = join(dataDir, TOMBSTONE_FILE);
    this.now = opts.now ?? (() => new Date());
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load(): void {
    const records = readJson<{ records?: unknown }>(this.file)?.records;
    this.records = (Array.isArray(records) ? records as MemoryRecord[] : [])
      .filter(r => !!r && typeof r.id === 'string' && typeof r.text === 'string')
      .map(r => ({ ...r, useCount: Number(r.useCount) || 0, forgotten: r.forgotten === true }));
    const stones = readJson<{ tombstones?: unknown }>(this.tombstoneFile)?.tombstones;
    this.tombstones = (Array.isArray(stones) ? stones : [])
      .filter((t): t is Tombstone => !!t && typeof (t as Tombstone).hash === 'string');
  }

  private save(): void {
    writeJson(this.file, { records: this.records });
  }

  private saveTombstones(): void {
    writeJson(this.tombstoneFile, { tombstones: this.tombstones });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /**
   * Record something worth keeping, or update what is already there.
   *
   * Saying the same thing again — same normalised text, same subject — updates
   * the record in place rather than inserting a near-duplicate, and revives it
   * if it had been forgotten. A reflection may not revive forgotten text.
   */
  remember(text: string, subject: string, kind: MemoryKind, source: MemorySource): MemoryRecord {
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('memory text is empty');
    const key = normalise(clean);
    const who = String(subject || HOUSEHOLD);
    const fromReflection = isReflection(source);

    if (this.isTombstoned(clean, who)) {
      if (fromReflection) throw new MemoryTombstonedError(who);
      // A person said it again, so it is theirs to keep.
      this.clearTombstone(clean, who);
    }

    const at = this.stamp();
    const existing = this.records.find(r => r.subject === who && normalise(r.text) === key);
    if (existing) {
      existing.text = clean;
      existing.kind = kind;
      existing.source = source;
      existing.forgotten = false;
      existing.updatedAt = at;
      this.save();
      return { ...existing };
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      text: clean,
      subject: who,
      kind,
      source,
      createdAt: at,
      updatedAt: at,
      useCount: 0,
      forgotten: false,
    };
    this.records.push(record);
    this.save();
    return { ...record };
  }

  /**
   * What is worth reading, given a question — across the whole household.
   *
   * The number of query terms a record contains decides the order; a record
   * that contains none is left out entirely rather than padding the answer.
   * Use count and staleness only break ties. Every record handed back is
   * counted as used, which is what makes the useful ones win next time.
   *
   * This reads everything, so it is for gombwe's own passes. Anything asked on
   * behalf of a person goes through `recallFor`.
   */
  recall(query: string, opts: MemoryRecallOptions = {}): MemoryRecord[] {
    return this.rank(this.records.filter(r => !r.forgotten), query, opts);
  }

  /**
   * `recall` as one principal, which is what every caller outside this class
   * wants. Records the principal may not read are dropped before anything is
   * scored, so they are neither returned nor counted as used — a question from
   * one household member must not nudge the ranking of another member's
   * memories. An unknown caller is treated as a guest.
   */
  recallFor(
    principal: Principal | undefined,
    query: string,
    opts: MemoryRecallOptions = {},
  ): MemoryRecord[] {
    return this.rank(this.visibleTo(principal ?? ANONYMOUS), query, opts);
  }

  /** The scoring, the cut and the use-count bump, over a pool already filtered. */
  private rank(pool: MemoryRecord[], query: string, opts: MemoryRecallOptions): MemoryRecord[] {
    const terms = [...new Set(normalise(query).split(' ').filter(t => t.length >= MIN_TERM))];
    if (terms.length === 0) return [];
    const nowMs = this.now().getTime();

    const scored = pool
      .filter(r => (opts.subject ? r.subject === opts.subject : true))
      .filter(r => (opts.kind ? r.kind === opts.kind : true))
      .map(r => {
        const haystack = `${normalise(r.text)} ${normalise(r.subject)}`;
        const matched = terms.filter(t => haystack.includes(t)).length;
        return { record: r, matched, score: matched * TERM_WEIGHT + this.tieBreak(r, nowMs) };
      })
      .filter(s => s.matched > 0)
      .sort((a, b) => b.score - a.score);

    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_RECALL_LIMIT;
    const hits = scored.slice(0, limit).map(s => s.record);
    if (hits.length === 0) return [];

    const usedAt = this.stamp();
    for (const hit of hits) {
      hit.useCount += 1;
      hit.lastUsedAt = usedAt;
    }
    // Being read is not a change to what is remembered, so `updatedAt` — and
    // with it every session's memory stamp — is deliberately left alone.
    this.save();
    return hits.map(r => ({ ...r }));
  }

  /** Use count, less a light penalty for staleness. Never more than ±USE_CAP. */
  private tieBreak(r: MemoryRecord, nowMs: number): number {
    const days = Math.max(0, (nowMs - Date.parse(r.updatedAt)) / 86_400_000);
    const stale = Math.min(Number.isFinite(days) ? days : RECENCY_CAP_DAYS, RECENCY_CAP_DAYS);
    return Math.min(r.useCount, USE_CAP) - stale * RECENCY_WEIGHT;
  }

  /**
   * Forget a record by id, or by what it says. The record stays on file marked
   * `forgotten` and a tombstone goes down, so no reflection writes it back.
   */
  forget(idOrText: string): MemoryRecord | undefined {
    const wanted = String(idOrText ?? '').trim();
    if (!wanted) return undefined;
    const key = normalise(wanted);
    const record = this.records.find(r => r.id === wanted)
      ?? [...this.records]
        .filter(r => !r.forgotten && normalise(r.text) === key)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!record) return undefined;

    const at = this.stamp();
    record.forgotten = true;
    record.updatedAt = at;
    this.save();

    const hash = hashOf(record.text, record.subject);
    if (!this.tombstones.some(t => t.hash === hash)) {
      this.tombstones.push({ hash, subject: record.subject, source: record.source, at });
      this.saveTombstones();
    }
    return { ...record };
  }

  /** Was this text, for this subject, forgotten? */
  isTombstoned(text: string, subject: string): boolean {
    const hash = hashOf(text, subject);
    return this.tombstones.some(t => t.hash === hash);
  }

  private clearTombstone(text: string, subject: string): void {
    const hash = hashOf(text, subject);
    const before = this.tombstones.length;
    this.tombstones = this.tombstones.filter(t => t.hash !== hash);
    if (this.tombstones.length !== before) this.saveTombstones();
  }

  /** Everything remembered, newest change first. */
  list(opts: MemoryListOptions = {}): MemoryRecord[] {
    return this.records
      .filter(r => (opts.includeForgotten ? true : !r.forgotten))
      .filter(r => (opts.subject ? r.subject === opts.subject : true))
      .filter(r => (opts.kind ? r.kind === opts.kind : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(r => ({ ...r }));
  }

  /**
   * The newest change to what is remembered, or '' when nothing is. A session
   * that was given the context block holds this string; when it moves, the
   * block is worth prepending again.
   */
  updatedAt(): string {
    return this.records.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), '');
  }

  /** The records this principal may read: their own and the household's. */
  private visibleTo(principal: Principal): MemoryRecord[] {
    return this.records.filter(r => !r.forgotten && mayRead(principal, r));
  }

  /**
   * What to prepend to a conversation: the memories this principal may read,
   * most actionable kind first and newest within a kind, up to a character
   * budget. The budget covers the memory lines; the wrapper and the tool hint
   * are always there, because a truncated block still needs to say how to add
   * to it. '' when there is nothing to say, so callers can prepend blindly.
   */
  contextBlock(principal: Principal, budgetChars: number = DEFAULT_BUDGET_CHARS): string {
    const visible = this.visibleTo(principal).sort((a, b) => {
      const byKind = kindRank(a.kind) - kindRank(b.kind);
      return byKind !== 0 ? byKind : b.updatedAt.localeCompare(a.updatedAt);
    });

    const lines: string[] = [];
    let used = 0;
    for (const r of visible) {
      const line = `- [${r.kind}|${r.subject}] ${r.text}`;
      if (used + line.length + 1 > budgetChars) break;
      used += line.length + 1;
      lines.push(line);
    }
    if (lines.length === 0) return '';
    return `<household-memory>\n${lines.join('\n')}\n${TOOL_HINT}\n</household-memory>`;
  }
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    // A hand-edited or half-written store must not stop the gateway booting.
    return undefined;
  }
}

function writeJson(file: string, body: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, file);
}
