/**
 * Approvals: the human gate in front of the actions that must not happen alone.
 *
 * A short policy table maps a dotted action class to `auto`, `confirm` or
 * `never` (ADR 0004). There are no per-item allowlists: a new action inherits a
 * class and is gated the first time it is asked for. `credential` is `never`, so
 * the agent has no path to a password, a card number or a one-time code.
 *
 * A caller asks `request()` before doing the thing. `auto` means go ahead,
 * `never` is a refusal with a reason to pass back, and `confirm` hands back a
 * pending request that a human has 30 minutes to decide. Every pending request
 * has exactly one ledger line, opened as `pending` and closed as `ok`, `denied`
 * or `expired`, so the ledger alone tells you what was gated and how it ended.
 *
 * A caller that must block calls `wait()`, which resolves the moment a decision
 * or an expiry lands rather than polling. It returns the current (still pending)
 * request on timeout, because a held connection is worse than a second look.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Ledger } from './ledger.js';
import type { Principal, Principals } from './permissions.js';

/** A dotted action class. The six below are policed; anything else is `auto`. */
export type ApprovalClass =
  | 'pay' | 'send.external' | 'delete' | 'network.block.adult' | 'desktop.run' | 'credential'
  | (string & {});

export type Policy = 'auto' | 'confirm' | 'never';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: string;
  class: ApprovalClass;
  summary: string;
  params?: Record<string, unknown>;
  /** Principal id of whoever wants the action. */
  principal: string;
  sessionKey?: string;
  channel?: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** The ledger entry opened with this request; its outcome tracks the status. */
  ledgerId: string;
}

export interface ApprovalInput {
  class: ApprovalClass;
  summary: string;
  params?: Record<string, unknown>;
  principal: string;
  sessionKey?: string;
  channel?: string;
  /** Ledger action to record. Defaults to `approval.<class>`. */
  action?: string;
}

export type RequestResult =
  | { policy: 'auto' }
  | { policy: 'never'; reason: string }
  | { policy: 'confirm'; approval: ApprovalRequest };

export type Decision = 'approved' | 'denied';

/** Why a decide() call failed, so HTTP callers can pick a status code. */
export type ApprovalErrorCode = 'unknown' | 'forbidden' | 'settled';

export class ApprovalError extends Error {
  constructor(message: string, readonly code: ApprovalErrorCode) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export const POLICIES: Policy[] = ['auto', 'confirm', 'never'];

/** ADR 0004's table. Everything not named here is `auto`. */
export const DEFAULT_POLICIES: Record<string, Policy> = {
  pay: 'confirm',
  'send.external': 'confirm',
  delete: 'confirm',
  'network.block.adult': 'confirm',
  'desktop.run': 'confirm',
  credential: 'never',
};

const FILE = 'approvals.json';
const DEFAULT_TTL_MS = 30 * 60_000;
/** Settled requests kept on disk, newest first. Pending ones are always kept. */
const HISTORY_LIMIT = 500;
/** Shortest id prefix `/approve` accepts, so a typo cannot hit a real request. */
export const MIN_PREFIX = 6;

export type PrefixMatch =
  | { ok: true; id: string }
  | { ok: false; reason: 'short' }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] };

/**
 * Resolve what a human typed to one approval id: a full id, or a prefix of at
 * least six characters that only one candidate starts with. Ambiguity is
 * reported rather than guessed — approving the wrong request spends money.
 */
export function matchApprovalId(input: string, ids: string[]): PrefixMatch {
  const wanted = String(input ?? '').trim().toLowerCase();
  const exact = ids.find(id => id.toLowerCase() === wanted);
  if (exact) return { ok: true, id: exact };
  if (wanted.length < MIN_PREFIX) return { ok: false, reason: 'short' };
  const candidates = ids.filter(id => id.toLowerCase().startsWith(wanted));
  if (candidates.length === 0) return { ok: false, reason: 'unknown' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates };
  return { ok: true, id: candidates[0] };
}

/** First 8 characters of an id — what the chat commands and alerts show. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export class Approvals extends EventEmitter {
  private file: string;
  private policyTable: Record<string, Policy> = { ...DEFAULT_POLICIES };
  private requests: ApprovalRequest[] = [];
  private ttlMs: number;
  private now: () => Date;
  /** Re-entrancy guard: a listener that reads during expiry must not recurse. */
  private expiring = false;

  constructor(
    dataDir: string,
    private ledger: Ledger,
    private principals: Principals,
    opts: { ttlMs?: number; now?: () => Date } = {},
  ) {
    super();
    // A dozen agent sessions can wait on approvals at once; the default limit
    // of 10 listeners would print a warning that means nothing here.
    this.setMaxListeners(0);
    this.file = join(dataDir, FILE);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  // ── Policies ────────────────────────────────────────────────

  policyFor(cls: ApprovalClass): Policy {
    return this.policyTable[cls] ?? 'auto';
  }

  setPolicy(cls: ApprovalClass, policy: Policy): void {
    if (!POLICIES.includes(policy)) throw new Error(`policy must be one of ${POLICIES.join(', ')}`);
    this.policyTable[String(cls)] = policy;
    this.save();
  }

  policies(): Record<string, Policy> {
    return { ...this.policyTable };
  }

  // ── Requesting ──────────────────────────────────────────────

  request(input: ApprovalInput): RequestResult {
    const cls = String(input.class);
    const policy = this.policyFor(cls);
    if (policy === 'auto') return { policy: 'auto' };
    if (policy === 'never') {
      // A refusal is a side effect too: without a line here, the one class that
      // can never be approved would be the one class with no audit trail.
      this.ledger.record({
        actor: 'system',
        principal: input.principal,
        action: input.action ?? `approval.${cls}`,
        target: input.summary,
        params: input.params,
        outcome: 'denied',
        error: 'policy never',
      });
      return {
        policy: 'never',
        reason: `${cls} is set to never, so gombwe will not do this — a person has to.`,
      };
    }

    const now = this.now();
    const id = randomUUID();
    const entry = this.ledger.record({
      actor: 'system',
      principal: input.principal,
      action: input.action ?? `approval.${cls}`,
      target: input.summary,
      params: input.params,
      outcome: 'pending',
      approvalId: id,
      sessionKey: input.sessionKey,
    });
    const approval: ApprovalRequest = {
      id,
      class: cls,
      summary: input.summary,
      params: input.params,
      principal: input.principal,
      sessionKey: input.sessionKey,
      channel: input.channel,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      ledgerId: entry.id,
    };
    this.requests.push(approval);
    this.save();
    this.emit('approval:requested', clone(approval));
    return { policy: 'confirm', approval: clone(approval) };
  }

  // ── Deciding ────────────────────────────────────────────────

  /**
   * Record a human decision. The owner decides anything; an adult decides their
   * own request; anyone may deny a request they raised. The deciding principal
   * is re-read from the roster, so a Principal captured earlier (on a chat
   * message, say) cannot still approve after being demoted.
   */
  decide(id: string, by: Principal, decision: Decision): ApprovalRequest {
    this.expireDue();
    const req = this.requests.find(r => r.id === id);
    if (!req) throw new ApprovalError(`unknown approval: ${id}`, 'unknown');
    const actor = (by?.id ? this.principals.get(by.id) : undefined) ?? by;
    if (!mayDecide(actor, req, decision)) {
      throw new ApprovalError(
        `${actor?.name ?? 'unknown caller'} may not ${decision === 'approved' ? 'approve' : 'deny'} ` +
        `${req.class} [${shortId(req.id)}]`,
        'forbidden',
      );
    }
    // Asked twice — a double-tap on the dashboard, or a retried POST.
    if (req.status === decision) return clone(req);
    if (req.status !== 'pending') {
      throw new ApprovalError(`approval [${shortId(req.id)}] is already ${req.status}`, 'settled');
    }

    req.status = decision;
    req.decidedAt = this.now().toISOString();
    req.decidedBy = actor.id;
    this.ledger.update(req.ledgerId, { outcome: decision === 'approved' ? 'ok' : 'denied' });
    this.save();
    this.emit('approval:decided', clone(req));
    return clone(req);
  }

  // ── Reading ─────────────────────────────────────────────────

  get(id: string): ApprovalRequest | undefined {
    this.expireDue();
    const found = this.requests.find(r => r.id === id);
    return found ? clone(found) : undefined;
  }

  listPending(): ApprovalRequest[] {
    this.expireDue();
    return this.requests.filter(r => r.status === 'pending').map(clone);
  }

  /** Newest first, pending and settled. Used by the dashboard's history view. */
  list(limit = 100): ApprovalRequest[] {
    this.expireDue();
    return [...this.requests].reverse().slice(0, Math.max(1, limit)).map(clone);
  }

  /**
   * Block until this request is decided or expires, or until `timeoutMs` passes
   * — in which case the still-pending request comes back, and the caller is
   * expected to stop rather than hold its connection open (ADR 0004).
   */
  wait(id: string, timeoutMs: number): Promise<ApprovalRequest> {
    const current = this.get(id);
    if (!current) return Promise.reject(new ApprovalError(`unknown approval: ${id}`, 'unknown'));
    if (current.status !== 'pending') return Promise.resolve(current);

    return new Promise<ApprovalRequest>(resolve => {
      let settled = false;
      const finish = (req: ApprovalRequest) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('approval:decided', onSettled);
        this.off('approval:expired', onSettled);
        resolve(req);
      };
      const onSettled = (req: ApprovalRequest) => {
        if (req.id === id) finish(clone(req));
      };
      const timer = setTimeout(
        // Expire on the way out, so a timeout never reports a request as
        // pending when its 30 minutes have already run out.
        () => finish(this.get(id) ?? current),
        Math.max(0, timeoutMs),
      );
      // Deliberately not unref'd: a caller is awaiting this, and an unref'd
      // timer would let an otherwise idle event loop drain and never resolve it.
      this.on('approval:decided', onSettled);
      this.on('approval:expired', onSettled);
    });
  }

  /**
   * Close out anything past its expiry. Called from a 30 s interval and from
   * every read, so nothing ever observes a request that is pending on paper and
   * expired by the clock.
   */
  expireDue(): number {
    if (this.expiring) return 0;
    this.expiring = true;
    try {
      const now = this.now().getTime();
      const expired: ApprovalRequest[] = [];
      for (const req of this.requests) {
        if (req.status !== 'pending') continue;
        const at = Date.parse(req.expiresAt);
        // An unparseable expiresAt (hand-edited file) is left alone rather than
        // expired immediately, so a bad edit cannot cancel a live request.
        if (!Number.isFinite(at) || now < at) continue;
        req.status = 'expired';
        req.decidedAt = new Date(now).toISOString();
        this.ledger.update(req.ledgerId, { outcome: 'expired' });
        expired.push(req);
      }
      if (expired.length) this.save();
      this.expiring = false;
      for (const req of expired) this.emit('approval:expired', clone(req));
      return expired.length;
    } finally {
      this.expiring = false;
    }
  }

  // ── Storage ─────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as {
        policies?: Record<string, Policy>;
        requests?: ApprovalRequest[];
      };
      for (const [cls, policy] of Object.entries(parsed?.policies ?? {})) {
        if (POLICIES.includes(policy)) this.policyTable[cls] = policy;
      }
      this.requests = (Array.isArray(parsed?.requests) ? parsed.requests : [])
        .filter((r): r is ApprovalRequest => !!r && typeof r.id === 'string' && typeof r.ledgerId === 'string');
    } catch {
      // A hand-edited or half-written file must not stop the gateway booting.
      // Losing a pending request is safe: it fails closed, since the caller
      // never gets an approval id.
      this.policyTable = { ...DEFAULT_POLICIES };
      this.requests = [];
    }
  }

  private save(): void {
    const pending = this.requests.filter(r => r.status === 'pending');
    const settled = this.requests.filter(r => r.status !== 'pending');
    // History is bounded; the ledger keeps the permanent record.
    const kept = settled.slice(-HISTORY_LIMIT);
    if (kept.length !== settled.length) {
      this.requests = this.requests.filter(r => r.status === 'pending' || kept.includes(r));
    }
    const payload = {
      policies: this.policyTable,
      requests: [...kept, ...pending].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * Who may decide. Approving spends money or reaches outside the household, so
 * it needs an owner, or an adult acting on their own request. Denying is always
 * safe for the person who asked, so they may take their own request back.
 */
function mayDecide(by: Principal | undefined, req: ApprovalRequest, decision: Decision): boolean {
  if (!by) return false;
  if (by.role === 'owner') return true;
  if (decision === 'denied') return by.id === req.principal;
  return by.role === 'adult' && by.id === req.principal;
}

function clone(r: ApprovalRequest): ApprovalRequest {
  return { ...r, params: r.params ? { ...r.params } : undefined };
}
