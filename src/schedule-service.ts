/**
 * Per-device recurring schedules — block by MAC during configured time
 * windows on configured weekdays. Backed by MikroTik's *firewall time
 * matcher* (`time=21h-7h,mon,tue,...`) which the router evaluates per
 * packet. Survives gombwe outages because the rule lives on the router.
 *
 * Why not /system/scheduler? RouterOS 7.x gates that resource behind
 * device-mode which needs physical router access to unlock. The firewall
 * time matcher is always available and is arguably the cleaner design
 * anyway — one rule per schedule (vs N+1 cron-style entries) and the
 * router itself does the day/time arithmetic.
 *
 * Model:
 *   1 ScheduleDef ↔ 1 firewall rule, identified by comment "gombwe-sched <id>"
 *
 * Persistence: ~/.claude-gombwe/data/network/schedules.json
 *   Stores the gombwe-side definition (for the UI). Router state is the
 *   source of truth for execution; we re-derive the active rule from the
 *   comment tag.
 *
 * Limitations (v1):
 *   - Only recurring schedules. "Pause until <datetime>" uses the existing
 *     ad-hoc block flow on Access Control.
 *   - One rule per schedule = one MAC per schedule. Bundling multiple
 *     kids onto the same bedtime schedule = create one schedule per kid.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mikrotik } from './mikrotik-client.js';
import { loadConfig } from './config.js';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const SCHEDULES_PATH = join(DATA_DIR, 'schedules.json');

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const ALL_DAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export type ScheduleType = 'recurring' | 'pause-until';

export interface ScheduleDef {
  id: string;
  type: ScheduleType;
  name: string;
  mac: string;             // target device, uppercase AA:BB:CC:DD:EE:FF
  // Recurring-only fields (undefined for pause-until)
  days?: Weekday[];
  start_time?: string;     // "HH:MM" 24h
  end_time?: string;       // "HH:MM" 24h — wraps midnight if < start_time
  // Pause-until-only field
  pause_until?: string;    // ISO datetime — when the block auto-lifts
  enabled: boolean;
  created_at: string;
}

interface PersistedState { schedules: ScheduleDef[] }

function load(): PersistedState {
  if (!existsSync(SCHEDULES_PATH)) return { schedules: [] };
  try { return JSON.parse(readFileSync(SCHEDULES_PATH, 'utf-8')); }
  catch { return { schedules: [] }; }
}

function save(state: PersistedState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SCHEDULES_PATH, JSON.stringify(state, null, 2));
}

/** Build the RouterOS time-matcher string from our model.
 *  Example: "21:00".."07:00" on weekdays  →  "21:00:00-07:00:00,mon,tue,wed,thu,fri"
 *  RouterOS accepts HH:MM:SS-HH:MM:SS plus a comma-separated weekday list. */
function timeMatcher(args: { days: Weekday[]; start_time: string; end_time: string }): string {
  const days = (args.days.length === 0 ? ALL_DAYS : args.days).slice();
  // Keep the standard order so RouterOS displays it consistently.
  days.sort((a, b) => ALL_DAYS.indexOf(a) - ALL_DAYS.indexOf(b));
  return `${args.start_time}:00-${args.end_time}:00,${days.join(',')}`;
}

/** Remove all router-side state (firewall rule + scheduler entry) for this
 *  schedule id. Idempotent — recurring schedules have only a rule, pause-until
 *  schedules have a rule + a scheduler entry; we mop up both either way. */
async function tearDownRouterSide(sid: string): Promise<void> {
  // Both recurring (gombwe-sched <id>) and pause-until (gombwe-pause <id>)
  // use distinct comment prefixes so they don't collide.
  const rules = await mikrotik.filterRules();
  for (const r of rules) {
    const c = r.comment || '';
    if (c.startsWith(`gombwe-sched ${sid}`) || c.startsWith(`gombwe-pause ${sid}`)) {
      await mikrotik.removeRule(r['.id']).catch(() => { /* tolerate */ });
    }
  }
  // Scheduler entries: pause-until end scheduler + recurring audit-fire pair.
  const schedulers = await mikrotik.schedulers();
  for (const s of schedulers) {
    const c = s.comment || '';
    if (c.startsWith(`gombwe-pause ${sid}`) || c.startsWith(`gombwe-sched ${sid}`)) {
      await mikrotik.removeScheduler(s['.id']).catch(() => { /* tolerate */ });
    }
  }
}

/** Find a LAN-ish IPv4 address the router can reach gombwe on. Picks the
 *  first private-range non-loopback IPv4 from any local interface.
 *  Used to bake a callback URL into router-side schedule scripts so the
 *  router can /tool/fetch us when a window opens/closes. */
function gombweCallbackBase(): string | null {
  const config = loadConfig();
  const port = config.port || 18790;
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      // RFC1918 only — we never want to bake a public IP into router config.
      const m = i.address.match(/^(?:10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
      if (m) return `http://${i.address}:${port}`;
    }
  }
  return null;
}

/** Format a JS Date for RouterOS scheduler. start-date wants YYYY-MM-DD,
 *  start-time wants HH:MM:SS. RouterOS interprets in its local timezone
 *  (which we assume matches the gombwe host — both Melbourne in our setup). */
function formatRouterStartDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatRouterStartTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function provisionRouterSide(def: ScheduleDef): Promise<void> {
  if (!def.enabled) return;

  if (def.type === 'recurring') {
    if (!def.start_time || !def.end_time) return;
    const days = def.days || [];
    // RouterOS firewall `time` does NOT wrap past midnight. For an overnight
    // window (start > end, e.g. 21:00–06:30) a single rule would never match,
    // so split into two: [start–23:59:59] + [00:00:00–end]. For everyday
    // schedules, blocking every morning 00:00–end is exactly what's wanted.
    if (def.start_time > def.end_time) {
      await mikrotik.addScheduledMacBlock(
        def.mac, `${def.start_time}:00-23:59:59,${days.join(',')}`, `gombwe-sched ${def.id} ${def.name} (eve)`,
      );
      await mikrotik.addScheduledMacBlock(
        def.mac, `00:00:00-${def.end_time}:00,${days.join(',')}`, `gombwe-sched ${def.id} ${def.name} (morn)`,
      );
    } else {
      const matcher = timeMatcher({ days, start_time: def.start_time, end_time: def.end_time });
      await mikrotik.addScheduledMacBlock(
        def.mac, matcher, `gombwe-sched ${def.id} ${def.name}`,
      );
    }
    // Optional audit-on-fire companions: 2 scheduler entries that POST to a
    // gombwe webhook when the window opens / closes. Router still does the
    // actual blocking via the time matcher above; these are notification only.
    // Skipped if scheduler is gated by device-mode (older routers / unconfigured)
    // — provisioning a companion is best-effort; failure doesn't break the
    // schedule itself.
    const callback = gombweCallbackBase();
    if (callback) {
      const fetchOk = `:do {/tool/fetch url="${callback}/api/network/schedule-fired?id=${def.id}&event=start" output=none keep-result=no} on-error={}`;
      const fetchOff = `:do {/tool/fetch url="${callback}/api/network/schedule-fired?id=${def.id}&event=end" output=none keep-result=no} on-error={}`;
      // interval=1d gets evaluated each day; gombwe applies the weekday
      // filter from def.days at receive time (RouterOS scheduler doesn't
      // natively day-of-week filter, but we don't need router-side filtering
      // for notification — gombwe just won't log on non-active days).
      try {
        await mikrotik.addScheduler({
          name: `gombwe-sched-${def.id}-on-fire`,
          startTime: `${def.start_time}:00`, interval: '1d',
          onEvent: fetchOk,
          comment: `gombwe-sched ${def.id} fire start`,
        });
        await mikrotik.addScheduler({
          name: `gombwe-sched-${def.id}-off-fire`,
          startTime: `${def.end_time}:00`, interval: '1d',
          onEvent: fetchOff,
          comment: `gombwe-sched ${def.id} fire end`,
        });
      } catch (err) {
        console.warn('[schedule] audit-on-fire scheduler entries skipped (device-mode scheduler may be off):', (err as Error).message);
      }
    }
    return;
  }

  if (def.type === 'pause-until') {
    if (!def.pause_until) return;
    const until = new Date(def.pause_until);
    if (until.getTime() <= Date.now()) {
      // Already in the past — nothing to do. Caller should validate this.
      return;
    }
    // 1. Immediate firewall drop for this MAC (no time matcher — always on
    //    until removed). Comment carries the id so we can find it later.
    await mikrotik.addMacBlock(def.mac, `gombwe-pause ${def.id} active`);
    // 2. Scheduler entry that fires once at pause_until. on-event removes
    //    the firewall rule AND the scheduler entry itself (self-cleanup).
    //    interval=0s = one-shot. interval-less is rejected by REST, hence 0s.
    const onEvent =
      `:foreach r in=[/ip/firewall/filter/find comment="gombwe-pause ${def.id} active"] do={/ip/firewall/filter/remove $r}; ` +
      `:foreach s in=[/system/scheduler/find comment~"gombwe-pause ${def.id}"] do={/system/scheduler/remove $s}`;
    await mikrotik.addScheduler({
      name: `gombwe-pause-${def.id}-end`,
      startDate: formatRouterStartDate(until),
      startTime: formatRouterStartTime(until),
      interval: '0s',
      onEvent,
      comment: `gombwe-pause ${def.id} end`,
    });
    return;
  }
}

// ── Public API ─────────────────────────────────────────────────

export function list(): ScheduleDef[] {
  return load().schedules.slice();
}

export function getById(id: string): ScheduleDef | null {
  return load().schedules.find(s => s.id === id) || null;
}

/** Check whether `now` falls on one of the schedule's active weekdays.
 *  Used by the schedule-fired webhook so we only log audit entries on days
 *  when the firewall rule would actually have been active. */
export function isActiveToday(def: ScheduleDef, now = new Date()): boolean {
  if (def.type !== 'recurring' || !def.days?.length) return true;
  const todayName = (['sun','mon','tue','wed','thu','fri','sat'] as const)[now.getDay()];
  return def.days.includes(todayName);
}

export async function create(input: Omit<ScheduleDef, 'id' | 'created_at' | 'enabled'> & { enabled?: boolean }): Promise<ScheduleDef> {
  const type: ScheduleType = input.type || 'recurring';
  // Type-specific validation so we fail fast with a clear error instead of
  // creating a half-broken router-side state.
  if (type === 'recurring') {
    if (!input.start_time || !input.end_time) {
      throw new Error('recurring schedule requires start_time and end_time');
    }
  } else if (type === 'pause-until') {
    if (!input.pause_until) throw new Error('pause-until schedule requires pause_until');
    const until = new Date(input.pause_until);
    if (isNaN(until.getTime())) throw new Error('pause_until is not a valid datetime');
    if (until.getTime() <= Date.now()) throw new Error('pause_until must be in the future');
  } else {
    throw new Error(`unknown schedule type: ${type}`);
  }

  const def: ScheduleDef = {
    id: randomUUID().slice(0, 8),
    type,
    name: input.name,
    mac: input.mac.toUpperCase(),
    days: input.days,
    start_time: input.start_time,
    end_time: input.end_time,
    pause_until: input.pause_until,
    enabled: input.enabled !== false,
    created_at: new Date().toISOString(),
  };
  await provisionRouterSide(def);
  const state = load();
  state.schedules.push(def);
  save(state);
  return def;
}

export async function update(id: string, patch: Partial<Omit<ScheduleDef, 'id' | 'created_at'>>): Promise<ScheduleDef | null> {
  const state = load();
  const idx = state.schedules.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const next = { ...state.schedules[idx], ...patch };
  if (patch.mac) next.mac = patch.mac.toUpperCase();
  // Easiest correct path: tear down and re-provision. Cheap and avoids
  // PATCH semantics that vary across RouterOS versions.
  await tearDownRouterSide(id);
  await provisionRouterSide(next);
  state.schedules[idx] = next;
  save(state);
  return next;
}

export async function remove(id: string): Promise<boolean> {
  const state = load();
  const idx = state.schedules.findIndex(s => s.id === id);
  await tearDownRouterSide(id);  // even on orphan removal
  if (idx < 0) return false;
  state.schedules.splice(idx, 1);
  save(state);
  return true;
}

/** Diagnostic: what router-side state does this schedule have?
 *  - rules: firewall drop rules tagged for this schedule
 *  - schedulers: scheduler entries tagged for this schedule (pause-until only)
 *  For recurring: `currently_active` reflects RouterOS's time-matcher state.
 *  For pause-until: `currently_active` is true while the immediate-block rule exists. */
export async function inspect(id: string) {
  const [rules, schedulers] = await Promise.all([
    mikrotik.filterRules(),
    mikrotik.schedulers(),
  ]);
  const matchingRules = rules.filter(r => {
    const c = r.comment || '';
    return c.startsWith(`gombwe-sched ${id}`) || c.startsWith(`gombwe-pause ${id}`);
  });
  const matchingSchedulers = schedulers.filter(s => {
    const c = s.comment || '';
    return c.startsWith(`gombwe-pause ${id}`) || c.startsWith(`gombwe-sched ${id}`);
  });
  return {
    rules: matchingRules.map(r => ({
      id: r['.id'],
      time: r.time,
      disabled: r.disabled === 'true',
      currently_active: r['.about'] !== 'inactive time' && r.invalid !== 'true',
      bytes: r.bytes,
    })),
    schedulers: matchingSchedulers.map(s => ({
      id: s['.id'],
      name: s.name,
      interval: s.interval,
      next_run: s['next-run'],
    })),
  };
}
