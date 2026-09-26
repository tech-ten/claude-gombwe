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

const FILE = 'ledger.jsonl';
const DEFAULT_ROTATE_BYTES = 50 * 1024 * 1024;
const ROTATED = /^ledger-\d{8}T\d{6}(-\d+)?\.jsonl$/;

/** 2026-09-27T01:09:00.123Z → 20260927T010900 */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

export class Ledger {
  private file: string;
  private rotateBytes: number;
  private entries = new Map<string, LedgerEntry>();
  /** Insertion order, so entries sharing a timestamp still read newest-first. */
  private seq = new Map<string, number>();
  private nextSeq = 0;

  constructor(private dataDir: string, opts: { rotateBytes?: number } = {}) {
    this.file = join(dataDir, FILE);
    this.rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    for (const f of [...this.rotatedFiles().slice(0, 1).reverse(), this.file]) {
      this.load(f);
    }
  }

  /** Rotated files, newest first. Names sort chronologically. */
  private rotatedFiles(): string[] {
    return readdirSync(this.dataDir)
      .filter(f => ROTATED.test(f))
      .sort()
      .reverse()
      .map(f => join(this.dataDir, f));
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
      time: input.time ?? new Date().toISOString(),
    };
    this.append(entry);
    this.remember(entry);
    return entry;
  }

  /** Supersede an entry. Returns undefined if the id is unknown. */
  update(id: string, patch: LedgerPatch): LedgerEntry | undefined {
    const current = this.entries.get(id);
    if (!current) return undefined;
    const merged: LedgerEntry = { ...current, ...patch };
    this.append(merged);
    this.remember(merged);
    return merged;
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /** Newest first, folded by id. */
  list(filter: LedgerFilter = {}): LedgerEntry[] {
    const matches = [...this.entries.values()].filter(e => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.principal && e.principal !== filter.principal) return false;
      if (filter.outcome && e.outcome !== filter.outcome) return false;
      if (filter.action && !e.action.startsWith(filter.action)) return false;
      if (filter.since && e.time < filter.since) return false;
      return true;
    });
    matches.sort((a, b) =>
      a.time === b.time
        ? (this.seq.get(b.id) ?? 0) - (this.seq.get(a.id) ?? 0)
        : (a.time < b.time ? 1 : -1));
    return filter.limit != null ? matches.slice(0, filter.limit) : matches;
  }
}
