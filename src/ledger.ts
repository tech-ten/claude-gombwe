/**
 * Append-only action ledger.
 *
 * Every side effect gombwe takes — a chat action, a cron run, a dashboard
 * click, a script checkout — gets one line here. Lines are never rewritten:
 * an update appends a superseding line for the same id, and reads fold by id
 * so the last line wins. That keeps the file replayable and makes a partial
 * write (crash mid-append) cost at most one entry.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type LedgerActor =
  | 'chat' | 'task' | 'cron' | 'trigger' | 'goal' | 'monitor'
  | 'dashboard' | 'skill' | 'script' | 'remote' | 'system';

export type LedgerOutcome = 'ok' | 'failed' | 'denied' | 'pending' | 'expired';

export interface LedgerEntry {
  id: string;
  time: string;
  actor: LedgerActor;
  principal: string;
  action: string;
  target?: string;
  params?: Record<string, unknown>;
  outcome: LedgerOutcome;
  approvalId?: string;
  receipt?: Record<string, unknown>;
  sessionKey?: string;
  taskId?: string;
  goalId?: string;
  error?: string;
}

export interface LedgerFilter {
  actor?: LedgerActor;
  /** Prefix match, so `network.` matches `network.device.block`. */
  action?: string;
  outcome?: LedgerOutcome;
  since?: string;
  limit?: number;
  principal?: string;
}

export type LedgerInput =
  Omit<LedgerEntry, 'id' | 'time'> & { id?: string; time?: string };

export type LedgerPatch =
  Partial<Pick<LedgerEntry, 'outcome' | 'receipt' | 'error' | 'approvalId'>>;

/**
 * What a background engine reports about something it just did.
 *
 * The engines (triggers, workflows, the scheduler) know nothing about the
 * ledger or who owns it — they hand the gateway a description of the event and
 * it decides the principal and writes the line. Keeps the engines testable
 * without a data directory and keeps the ledger the gateway's business.
 */
export interface LedgerEvent {
  actor: LedgerActor;
  action: string;
  target?: string;
  params?: Record<string, unknown>;
  outcome: 'ok' | 'failed';
  receipt?: Record<string, unknown>;
  error?: string;
}

export type LedgerEventSink = (event: LedgerEvent) => void;

/**
 * Hand an event to a sink without letting a bad sink take the caller down: the
 * side effect already happened, and losing it over a broken subscriber would
 * be worse than losing the line.
 */
export function reportEvent(
  sink: LedgerEventSink | undefined,
  label: string,
  event: LedgerEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (err: any) {
    console.error(`[${label}] event sink threw for ${event.action}: ${err?.message}`);
  }
}

const FILE = 'ledger.jsonl';
const DEFAULT_ROTATE_BYTES = 50 * 1024 * 1024;
const MAX_LIMIT = 1000;
const ROTATED = /^ledger-\d{8}T\d{6}(-\d+)?\.jsonl$/;

/**
 * Canonical UTC ISO with milliseconds, so a string compare is a time compare.
 * Returns undefined for anything Date cannot parse.
 */
function isoTime(value: string): string | undefined {
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** 2026-09-27T01:09:00.123Z → 20260927T010900 */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

/**
 * Emits `'record'` with the entry that was just appended — by `record()` and by
 * `update()`, since a superseding line is as much news as a fresh one. The
 * gateway subscribes once and relays each entry to the dashboard over the
 * WebSocket, so no call site has to remember to broadcast.
 */
export class Ledger extends EventEmitter {
  private file: string;
  private rotateBytes: number;
  private entries = new Map<string, LedgerEntry>();
  /** Insertion order, so entries sharing a timestamp still read newest-first. */
  private seq = new Map<string, number>();
  private nextSeq = 0;

  constructor(private dataDir: string, opts: { rotateBytes?: number } = {}) {
    super();
    this.file = join(dataDir, FILE);
    this.rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    for (const f of [...this.rotatedFiles().slice(0, 1).reverse(), this.file]) {
      this.load(f);
    }
  }

  /**
   * Rotated files, newest first. Ordered by mtime rather than name, because a
   * same-second collision suffix (`…-2.jsonl`) does not sort chronologically.
   */
  private rotatedFiles(): string[] {
    return readdirSync(this.dataDir)
      .filter(f => ROTATED.test(f))
      .map(name => ({ name, path: join(this.dataDir, name) }))
      .map(f => ({ ...f, mtime: statSync(f.path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
      .map(f => f.path);
  }

  private load(file: string): void {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line) as LedgerEntry;
      } catch {
        continue; // torn final line from a crash mid-append
      }
      if (!entry?.id) continue;
      if (entry.time) entry.time = isoTime(entry.time) ?? entry.time;
      this.remember(entry);
    }
  }

  private remember(entry: LedgerEntry): void {
    if (!this.seq.has(entry.id)) this.seq.set(entry.id, this.nextSeq++);
    this.entries.set(entry.id, entry);
  }

  private append(entry: LedgerEntry): void {
    if (existsSync(this.file) && statSync(this.file).size > this.rotateBytes) {
      let target = join(this.dataDir, `ledger-${stamp(new Date())}.jsonl`);
      for (let n = 2; existsSync(target); n++) {
        target = join(this.dataDir, `ledger-${stamp(new Date())}-${n}.jsonl`);
      }
      renameSync(this.file, target);
    }
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }

  record(input: LedgerInput): LedgerEntry {
    const entry: LedgerEntry = {
      ...input,
      id: input.id ?? randomUUID(),
      // Normalised so offset times ('+10:00') and second-precision times sort
      // and compare against `since` correctly. An unparseable time falls back to now.
      time: (input.time && isoTime(input.time)) || new Date().toISOString(),
    };
    this.append(entry);
    this.remember(entry);
    this.announce(entry);
    return entry;
  }

  /** Supersede an entry. Returns undefined if the id is unknown. */
  update(id: string, patch: LedgerPatch): LedgerEntry | undefined {
    const current = this.entries.get(id);
    if (!current) return undefined;
    const merged: LedgerEntry = { ...current, ...patch };
    this.append(merged);
    this.remember(merged);
    this.announce(merged);
    return merged;
  }

  /**
   * A listener that throws must not unwind the writer: the line is already on
   * disk, and losing the caller's return value over a bad subscriber would be
   * the worse failure.
   */
  private announce(entry: LedgerEntry): void {
    try {
      this.emit('record', entry);
    } catch (err: any) {
      console.error(`[ledger] a 'record' listener threw: ${err?.message}`);
    }
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /** Newest first, folded by id. */
  list(filter: LedgerFilter = {}): LedgerEntry[] {
    // An unparseable `since` is ignored rather than filtering everything out.
    const since = filter.since ? isoTime(filter.since) : undefined;
    const matches = [...this.entries.values()].filter(e => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.principal && e.principal !== filter.principal) return false;
      if (filter.outcome && e.outcome !== filter.outcome) return false;
      if (filter.action && !e.action.startsWith(filter.action)) return false;
      if (since && e.time < since) return false;
      return true;
    });
    matches.sort((a, b) =>
      a.time === b.time
        ? (this.seq.get(b.id) ?? 0) - (this.seq.get(a.id) ?? 0)
        : (a.time < b.time ? 1 : -1));
    if (filter.limit == null || !Number.isFinite(filter.limit)) return matches;
    // Clamped: a negative limit would slice from the end and drop the newest rows.
    return matches.slice(0, Math.max(1, Math.min(filter.limit, MAX_LIMIT)));
  }
}
