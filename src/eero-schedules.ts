// Per-device / per-profile block schedules. Lives on the gombwe host so it works
// without eero Plus. A 60-second ticker evaluates every schedule and pushes
// pause/unpause to the eero API only when the desired state differs from the
// last-known state — idempotent and safe to run continuously.
//
// Two schedule shapes:
//   recurring  → list of weekly rules { days: [0..6], startMinutes, endMinutes }
//   one-off    → pauseUntil ISO timestamp; auto-deletes when it passes

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EeroClient } from './eero.js';
import type { EeroStore } from './eero-store.js';

const SCHEDULES_FILE = 'eero-schedules.json';
const STATE_FILE = 'eero-scheduler-state.json';

export interface ScheduleRule {
  days: number[];          // 0 = Sun, 6 = Sat
  startMinutes: number;    // 0..1439, minutes since local midnight
  endMinutes: number;      // 0..1439; if < startMinutes, block crosses midnight
}

export interface BlockSchedule {
  id: string;
  name: string;
  target: {
    type: 'device' | 'profile';
    url: string;            // eero url for the device/profile
    mac?: string;           // for devices, kept for display
    displayName?: string;   // human label (device or profile name)
  };
  enabled: boolean;
  rules?: ScheduleRule[];
  pauseUntil?: string;      // ISO timestamp; one-shot
  createdAt: string;
}

export class EeroScheduler {
  private dataDir: string;
  private client: EeroClient;
  private store: EeroStore;
  private timer: NodeJS.Timeout | null = null;
  private lastApplied: Map<string, boolean> = new Map(); // url -> last paused state we set

  constructor(dataDir: string, client: EeroClient, store: EeroStore) {
    this.dataDir = dataDir;
    this.client = client;
    this.store = store;
    this.loadState();
  }

  private loadState(): void {
    const f = join(this.dataDir, STATE_FILE);
    if (!existsSync(f)) return;
    try {
      const obj = JSON.parse(readFileSync(f, 'utf-8'));
      for (const [k, v] of Object.entries(obj)) this.lastApplied.set(k, !!v);
    } catch { /* ignore */ }
  }

  private saveState(): void {
    const obj: Record<string, boolean> = {};
    for (const [k, v] of this.lastApplied) obj[k] = v;
    writeFileSync(join(this.dataDir, STATE_FILE), JSON.stringify(obj, null, 2));
  }

  // ── persistence ─────────────────────────────────────────────────────
  list(): BlockSchedule[] {
    const f = join(this.dataDir, SCHEDULES_FILE);
    if (!existsSync(f)) return [];
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return []; }
  }

  private save(items: BlockSchedule[]): void {
    writeFileSync(join(this.dataDir, SCHEDULES_FILE), JSON.stringify(items, null, 2));
  }

  create(input: Omit<BlockSchedule, 'id' | 'createdAt'>): BlockSchedule {
    const item: BlockSchedule = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const items = this.list();
    items.push(item);
    this.save(items);
    this.tick().catch(() => {});
    return item;
  }

  update(id: string, patch: Partial<BlockSchedule>): BlockSchedule | null {
    const items = this.list();
    const idx = items.findIndex(s => s.id === id);
    if (idx < 0) return null;
    items[idx] = { ...items[idx], ...patch, id: items[idx].id, createdAt: items[idx].createdAt };
    this.save(items);
    this.tick().catch(() => {});
    return items[idx];
  }

  delete(id: string): boolean {
    const items = this.list();
    const next = items.filter(s => s.id !== id);
    if (next.length === items.length) return false;
    this.save(next);
    this.tick().catch(() => {});
    return true;
  }

  // ── evaluation ──────────────────────────────────────────────────────
  // Is `now` covered by `rule`? `now` is local time minutes-since-midnight
  // and `dayOfWeek` is 0-6 with Sunday = 0.
  static isInRule(rule: ScheduleRule, dayOfWeek: number, minutesNow: number): boolean {
    const { startMinutes: s, endMinutes: e, days } = rule;
    if (s === e) return false;
    if (s < e) {
      // Same-day block.
      return days.includes(dayOfWeek) && minutesNow >= s && minutesNow < e;
    }
    // Crosses midnight: from s today through e tomorrow.
    if (days.includes(dayOfWeek) && minutesNow >= s) return true;
    const yesterday = (dayOfWeek + 6) % 7;
    if (days.includes(yesterday) && minutesNow < e) return true;
    return false;
  }

  static isCurrentlyBlocked(schedule: BlockSchedule, now: Date = new Date()): boolean {
    if (!schedule.enabled) return false;
    if (schedule.pauseUntil) {
      return new Date(schedule.pauseUntil).getTime() > now.getTime();
    }
    if (!schedule.rules || schedule.rules.length === 0) return false;
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const dow = now.getDay();
    return schedule.rules.some(r => EeroScheduler.isInRule(r, dow, minutesNow));
  }

  // ── ticker ──────────────────────────────────────────────────────────
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 60_000);
    // Run once immediately so pause-for-duration commands take effect.
    this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Reconcile schedules → eero. Idempotent.
  async tick(): Promise<void> {
    const now = new Date();
    const items = this.list();

    // Auto-expire one-shots whose deadline has passed.
    let dirty = false;
    const surviving = items.filter(s => {
      if (s.pauseUntil && new Date(s.pauseUntil).getTime() <= now.getTime()) {
        dirty = true;
        return false;
      }
      return true;
    });
    if (dirty) this.save(surviving);

    // Group by target — a target is blocked if ANY enabled schedule says so.
    // We also include every target we've previously managed, defaulting to
    // false, so deleting a schedule (or disabling it) unpauses the device on
    // the next tick instead of leaving it stuck paused.
    const desired = new Map<string, { type: 'device' | 'profile'; url: string; blocked: boolean }>();
    for (const url of this.lastApplied.keys()) {
      // Type isn't stored in lastApplied; infer from URL convention. Eero
      // device URLs contain "/devices/" and profile URLs contain "/profiles/".
      const type: 'device' | 'profile' = url.includes('/profiles/') ? 'profile' : 'device';
      desired.set(`${type}:${url}`, { type, url, blocked: false });
    }
    for (const s of surviving) {
      const key = `${s.target.type}:${s.target.url}`;
      const cur = desired.get(key);
      const blocked = EeroScheduler.isCurrentlyBlocked(s, now);
      if (cur) cur.blocked = cur.blocked || blocked;
      else desired.set(key, { type: s.target.type, url: s.target.url, blocked });
    }

    // Snapshot lets us see the *current* paused state per target so we don't
    // hit the API when nothing has changed.
    const snap = this.store.loadSnapshot();
    const deviceState = new Map<string, boolean>();
    for (const d of (snap?.devices || [])) {
      if (d.url) deviceState.set(d.url, !!d.paused);
    }
    const profileState = new Map<string, boolean>();
    for (const p of (snap?.profiles || [])) {
      if (p.url) profileState.set(p.url, !!p.paused);
    }

    for (const { type, url, blocked } of desired.values()) {
      const last = this.lastApplied.get(url);
      const current = type === 'device' ? deviceState.get(url) : profileState.get(url);
      // Only push if state truly differs and we haven't just set it.
      if (last === blocked) continue;
      if (current === blocked) { this.lastApplied.set(url, blocked); continue; }
      try {
        if (type === 'device') {
          await this.client.setDevicePaused(url, blocked);
        } else {
          await this.client.setProfilePaused(url, blocked);
        }
        this.lastApplied.set(url, blocked);
        this.saveState();
        this.store.logAction(`schedule.apply`, { type, url, paused: blocked });
      } catch (err: any) {
        this.store.logAction(`schedule.error`, { type, url, paused: blocked, error: err.message });
      }
    }
  }

  // ── convenience: pause-for-duration ─────────────────────────────────
  pauseFor(target: BlockSchedule['target'], minutes: number, name?: string): BlockSchedule {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    return this.create({
      name: name || `Pause ${target.displayName || target.type} for ${minutes}m`,
      target,
      enabled: true,
      pauseUntil: until,
    });
  }
}
