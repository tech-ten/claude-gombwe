/**
 * Per-day, per-MAC history rollup.
 *
 * Raw inputs:
 *   - ~/.claude-gombwe/data/network/YYYY-MM-DD.jsonl       (snapshot stream from the collector)
 *   - ~/.claude-gombwe/data/network/dns-YYYY-MM-DD.jsonl   (DNS receiver stream)
 *   either form may be gzipped (`.jsonl.gz`) by the compactor.
 *
 * Output (one file per day):
 *   ~/.claude-gombwe/data/network/rollups/YYYY-MM-DD.json
 *
 * Shape:
 *   {
 *     date, generated_at,
 *     devices: [
 *       { mac, ip, name, owner,
 *         bytes_up, bytes_down, hours_active,
 *         first_seen, last_seen,
 *         dns_count, dns_blocked,
 *         top_destinations: [{ host, bytes, queries }],
 *         apps:    [{ app, category, bytes, queries }],
 *         categories: { social: bytes, video: bytes, … }
 *       },
 *       …
 *     ]
 *   }
 *
 * Behaviour:
 *   - At startup: scan raw JSONL for past days that have no rollup yet, backfill.
 *   - At midnight: write yesterday's rollup, then schedule the next midnight.
 *   - For today (in progress), the API computes on-demand from raw — no rollup written.
 *
 * The rollup is the single source of truth for any time window > today.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname, networkInterfaces } from 'node:os';
import { createGunzip } from 'node:zlib';
import { categorize, AppCategory } from './app-categories.js';
import { guessOwner } from './owner-heuristic.js';
import { mdnsListener } from './mdns-listener.js';

const DATA_DIR    = join(homedir(), '.claude-gombwe', 'data', 'network');
const ROLLUP_DIR  = join(DATA_DIR, 'rollups');
const ALIASES_PATH= join(homedir(), '.claude-gombwe', 'network-aliases.json');
const OWNERS_PATH = join(homedir(), '.claude-gombwe', 'network-owners.json');

export interface DeviceRollup {
  mac: string;
  ip: string;
  name: string;
  owner: string | null;
  bytes_up: number;
  bytes_down: number;
  hours_active: number;
  first_seen: string | null;
  last_seen: string | null;
  dns_count: number;
  dns_blocked: number;
  top_destinations: Array<{ host: string; bytes: number; queries: number }>;
  apps: Array<{ app: string; category: AppCategory; bytes: number; queries: number }>;
  categories: Partial<Record<AppCategory, number>>;
}

export interface DayRollup {
  date: string;              // YYYY-MM-DD
  schema: number;            // bump when buildDayRollup() output shape/logic changes — triggers backfill regen
  generated_at: string;      // ISO
  devices: DeviceRollup[];
}

/** Bump when the rollup logic or shape changes. Older rollups are auto-regenerated. */
const SCHEMA_VERSION = 2;

// ── filesystem helpers ────────────────────────────────────────────────

function ensureDir(p: string) {
  try { mkdirSync(p, { recursive: true }); } catch { /* exists */ }
}

function readJsonOrEmpty<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as T : fallback; }
  catch { return fallback; }
}

/** Read a .jsonl (or .jsonl.gz) into an array of parsed objects. Empty = []. */
export async function readJsonlMaybeGz(path: string): Promise<any[]> {
  if (!existsSync(path)) {
    // try the gzipped form
    const gz = path + '.gz';
    if (!existsSync(gz)) return [];
    return new Promise((resolve, reject) => {
      const out: any[] = [];
      let leftover = '';
      const s = createReadStream(gz).pipe(createGunzip());
      s.on('data', (chunk: Buffer) => {
        const text = leftover + chunk.toString('utf-8');
        const lines = text.split('\n');
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch { /* skip */ }
        }
      });
      s.on('end', () => {
        if (leftover.trim()) {
          try { out.push(JSON.parse(leftover)); } catch { /* skip */ }
        }
        resolve(out);
      });
      s.on('error', reject);
    });
  }
  const text = readFileSync(path, 'utf-8');
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function snapshotPath(date: string): string {
  return join(DATA_DIR, `${date}.jsonl`);
}
function dnsPath(date: string): string {
  return join(DATA_DIR, `dns-${date}.jsonl`);
}
function rollupPath(date: string): string {
  return join(ROLLUP_DIR, `${date}.json`);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Self-identification: MACs and friendly name of the device gombwe runs on.
 * Computed once — these are static for the lifetime of the install. */
function selfMacs(): Set<string> {
  const macs = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.mac && i.mac !== '00:00:00:00:00:00') macs.add(i.mac.toUpperCase());
    }
  }
  return macs;
}
function selfDisplayName(): string {
  return osHostname().replace(/\.local\.?$/i, '') || 'Mac mini · gombwe';
}
const HOST_MACS = selfMacs();
const HOST_NAME = selfDisplayName();

// ── core: build one day's rollup from raw inputs ──────────────────────

/**
 * Build a DayRollup for a single date from the raw JSONL files.
 * Pure function — does NOT write to disk. Caller decides.
 */
export async function buildDayRollup(date: string): Promise<DayRollup> {
  const aliases = readJsonOrEmpty<Record<string, string>>(ALIASES_PATH, {});
  const owners  = readJsonOrEmpty<Record<string, string>>(OWNERS_PATH, {});

  const snapshots = await readJsonlMaybeGz(snapshotPath(date));
  const dnsLog    = await readJsonlMaybeGz(dnsPath(date));

  // ── Per-MAC byte aggregation (5-tuple max, not snapshot sum). ───────
  interface ConnTotal { mac: string; host: string; up: number; down: number }
  const conns = new Map<string, ConnTotal>();          // 5-tuple → totals
  const minutesByMac = new Map<string, Set<string>>(); // mac → set of "HH:MM" buckets
  const ipByMac     = new Map<string, string>();      // most-recent IP we saw per MAC
  const firstSeenByMac = new Map<string, string>();
  const lastSeenByMac  = new Map<string, string>();

  // mac → known device-name candidates from this day's leases
  const nameCandidateByMac = new Map<string, string>();

  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object') continue;
    const ts: string = snap.ts || '';
    const minute = ts.slice(11, 16);      // "HH:MM"

    const ipToMac = new Map<string, string>();
    for (const lease of snap.devices || []) {
      const mac = (lease['mac-address'] || '').toUpperCase();
      const ip  = lease.address || '';
      if (!mac) continue;
      if (ip) ipToMac.set(ip, mac);
      if (ip && !ipByMac.has(mac)) ipByMac.set(mac, ip);
      if (lease['host-name'] && !nameCandidateByMac.has(mac)) {
        nameCandidateByMac.set(mac, lease['host-name']);
      }
      if (lease.status === 'bound') {
        if (!firstSeenByMac.has(mac) && ts) firstSeenByMac.set(mac, ts);
        if (ts) lastSeenByMac.set(mac, ts);
        const s = minutesByMac.get(mac) ?? new Set<string>();
        if (minute) s.add(minute);
        minutesByMac.set(mac, s);
      }
    }

    for (const c of snap.connections || []) {
      const srcAddr = c['src-address'] || '';
      const dstAddr = c['dst-address'] || '';
      const srcIp = srcAddr.split(':')[0];
      const dstIp = dstAddr.split(':')[0];
      if (!srcIp || !dstIp) continue;
      const mac = ipToMac.get(srcIp);
      if (!mac) continue;
      const origBytes = parseInt(c['orig-bytes'] ?? '0') || 0;
      const replBytes = parseInt(c['repl-bytes'] ?? '0') || 0;
      // dst-host placeholder = IP; refined below from DNS log
      const key = `${c.protocol ?? '?'}|${srcAddr}|${dstAddr}`;
      const existing = conns.get(key);
      if (!existing) {
        conns.set(key, { mac, host: dstIp, up: origBytes, down: replBytes });
      } else {
        if (origBytes > existing.up) existing.up = origBytes;
        if (replBytes > existing.down) existing.down = replBytes;
      }
    }
  }

  // ── DNS aggregation per (MAC, hostname). ─────────────────────────────
  // We don't have a direct MAC for each DNS query — only the client IP — but
  // we can stitch using ipByMac (the IP we last saw for each MAC that day).
  // Build the inverse mapping for lookup.
  const macByIp = new Map<string, string>();
  for (const [mac, ip] of ipByMac) macByIp.set(ip, mac);

  interface DnsAgg { count: number; blocked: number; lastHostIp?: string }
  const dnsByMacHost = new Map<string, Map<string, DnsAgg>>();   // mac → host → agg
  const dnsCountByMac    = new Map<string, number>();
  const dnsBlockedByMac  = new Map<string, number>();

  for (const q of dnsLog) {
    if (!q || !q.hostname) continue;
    const mac = macByIp.get(q.client_ip || '');
    if (!mac) continue;                           // can't attribute, skip
    dnsCountByMac.set(mac, (dnsCountByMac.get(mac) ?? 0) + 1);
    if (q.blocked) dnsBlockedByMac.set(mac, (dnsBlockedByMac.get(mac) ?? 0) + 1);

    const byHost = dnsByMacHost.get(mac) ?? new Map<string, DnsAgg>();
    const agg = byHost.get(q.hostname) ?? { count: 0, blocked: 0 };
    agg.count += 1;
    if (q.blocked) agg.blocked += 1;
    if (q.answer && !agg.lastHostIp) agg.lastHostIp = q.answer;
    byHost.set(q.hostname, agg);
    dnsByMacHost.set(mac, byHost);
  }

  // ── Per-MAC roll-up ─────────────────────────────────────────────────
  // Track all macs we've ever observed in this day across either stream.
  const allMacs = new Set<string>([
    ...minutesByMac.keys(),
    ...dnsByMacHost.keys(),
    ...nameCandidateByMac.keys(),
    ...[...conns.values()].map(c => c.mac),
  ]);

  const deviceRollups: DeviceRollup[] = [];

  for (const mac of allMacs) {
    let bytesUp = 0, bytesDown = 0;
    const bytesByDest = new Map<string, number>();          // destIP → bytes
    for (const t of conns.values()) {
      if (t.mac !== mac) continue;
      bytesUp   += t.up;
      bytesDown += t.down;
      bytesByDest.set(t.host, (bytesByDest.get(t.host) ?? 0) + t.up + t.down);
    }

    // Roll DNS into apps and categories. Bytes-per-app is approximated by
    // distributing destination bytes proportionally to how many DNS queries
    // hit hostnames belonging to that app. Imperfect (no SNI inspection), but
    // a strong signal for the trend view.
    const appsAgg   = new Map<string, { category: AppCategory; bytes: number; queries: number }>();
    const categories: Partial<Record<AppCategory, number>> = {};
    const hostByApp = new Map<string, string[]>();          // app → hostnames
    const queriesPerHost = new Map<string, number>();

    const dnsHosts = dnsByMacHost.get(mac);
    if (dnsHosts) {
      for (const [host, agg] of dnsHosts) {
        queriesPerHost.set(host, agg.count);
        const { app, category } = categorize(host);
        const appKey = app ?? '__uncategorized__';
        const cur = appsAgg.get(appKey) ?? { category, bytes: 0, queries: 0 };
        cur.queries += agg.count;
        appsAgg.set(appKey, cur);
        const arr = hostByApp.get(appKey) ?? [];
        arr.push(host);
        hostByApp.set(appKey, arr);
      }
    }

    // Distribute destination bytes across apps based on DNS query share for
    // that destination's hostname (when we have one). We try to map each
    // destination *IP* back to a hostname by matching DNS answers — if no
    // match, the bytes land in __uncategorized__.
    const ipToHostnames = new Map<string, Set<string>>();
    if (dnsHosts) {
      for (const [host, agg] of dnsHosts) {
        if (!agg.lastHostIp) continue;
        const s = ipToHostnames.get(agg.lastHostIp) ?? new Set<string>();
        s.add(host);
        ipToHostnames.set(agg.lastHostIp, s);
      }
    }
    const topDestsRaw: Array<{ host: string; bytes: number; queries: number }> = [];
    for (const [dest, bytes] of bytesByDest) {
      // Resolve dest IP back to a hostname when possible
      const hosts = ipToHostnames.get(dest);
      const hostLabel = hosts && hosts.size > 0 ? [...hosts][0] : dest;
      const queries = queriesPerHost.get(hostLabel) ?? 0;
      topDestsRaw.push({ host: hostLabel, bytes, queries });

      const { app, category } = categorize(hostLabel);
      const appKey = app ?? '__uncategorized__';
      const cur = appsAgg.get(appKey) ?? { category, bytes: 0, queries: 0 };
      cur.bytes += bytes;
      appsAgg.set(appKey, cur);
      categories[category] = (categories[category] ?? 0) + bytes;
    }
    topDestsRaw.sort((a, b) => b.bytes - a.bytes);

    const apps = [...appsAgg.entries()]
      .map(([app, v]) => ({ app: app === '__uncategorized__' ? '(uncategorized)' : app, category: v.category, bytes: v.bytes, queries: v.queries }))
      .filter(a => a.bytes > 0 || a.queries > 0)
      .sort((a, b) => (b.bytes + b.queries * 50) - (a.bytes + a.queries * 50))
      .slice(0, 40);

    const hoursActive = (minutesByMac.get(mac)?.size ?? 0) / 60;
    const ip = ipByMac.get(mac) ?? '';
    const dhcpName = nameCandidateByMac.get(mac) ?? null;
    const isHost = HOST_MACS.has(mac);
    // mDNS: only useful for "today" or recently-seen devices (in-memory only,
    // not historical). For a yesterday rollup the mDNS lookup returns nothing,
    // which is fine — we fall through to DHCP/MAC.
    const mdnsHit = ip ? mdnsListener().getByIp(ip) : undefined;
    // Name precedence mirrors network-service.devices():
    //   alias > host-self (os.hostname) > mDNS instance > mDNS hostname > DHCP > MAC
    const displayName =
      aliases[mac] ??
      (isHost ? HOST_NAME : null) ??
      mdnsHit?.name ??
      mdnsHit?.host ??
      dhcpName ??
      mac;
    const resolvedOwner =
      owners[mac] ??
      guessOwner({
        name: displayName,
        hostname: dhcpName,
        mdns_name: mdnsHit?.name ?? null,
        mdns_host: mdnsHit?.host ?? null,
      }) ??
      null;
    deviceRollups.push({
      mac, ip,
      name: displayName,
      owner: resolvedOwner,
      bytes_up: bytesUp,
      bytes_down: bytesDown,
      hours_active: +hoursActive.toFixed(2),
      first_seen: firstSeenByMac.get(mac) ?? null,
      last_seen: lastSeenByMac.get(mac) ?? null,
      dns_count: dnsCountByMac.get(mac) ?? 0,
      dns_blocked: dnsBlockedByMac.get(mac) ?? 0,
      top_destinations: topDestsRaw.slice(0, 25),
      apps,
      categories,
    });
  }

  // Sort by total bytes desc so the first entries are the heavy hitters.
  deviceRollups.sort((a, b) => (b.bytes_up + b.bytes_down) - (a.bytes_up + a.bytes_down));

  return {
    date,
    schema: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    devices: deviceRollups,
  };
}

/** Write a rollup to disk (creates the dir on first write). */
function writeRollup(rollup: DayRollup): void {
  ensureDir(ROLLUP_DIR);
  writeFileSync(rollupPath(rollup.date), JSON.stringify(rollup, null, 2), { mode: 0o600 });
}

/** Read a rollup off disk; null if not generated yet. */
export function readRollup(date: string): DayRollup | null {
  const path = rollupPath(date);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as DayRollup; }
  catch { return null; }
}

/** Build + persist a rollup for a single date. */
export async function generateRollup(date: string): Promise<DayRollup> {
  const rollup = await buildDayRollup(date);
  writeRollup(rollup);
  return rollup;
}

// ── lifecycle: backfill on startup, schedule midnight write ──────────

/** Pick all dates that have raw input but no rollup — or a stale-schema rollup. */
function findMissingRollups(): string[] {
  ensureDir(DATA_DIR);
  ensureDir(ROLLUP_DIR);
  const today = ymd(new Date());

  // Build set of dates whose rollup is at the CURRENT schema. Anything else
  // (missing, or older schema) needs regeneration.
  const upToDate = new Set<string>();
  for (const f of readdirSync(ROLLUP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace(/\.json$/, '');
    try {
      const r = JSON.parse(readFileSync(join(ROLLUP_DIR, f), 'utf-8'));
      if (r && r.schema === SCHEMA_VERSION) upToDate.add(date);
    } catch { /* malformed; treat as missing → regen */ }
  }

  const seen = new Set<string>();
  for (const f of readdirSync(DATA_DIR)) {
    let date: string | null = null;
    if (/^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))     date = f.slice(0, 10);
    else if (/^dns-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)) date = f.slice(4, 14);
    if (!date) continue;
    if (date >= today) continue;        // never roll up today (still in progress)
    if (upToDate.has(date)) continue;
    seen.add(date);
  }
  return [...seen].sort();
}

/** Build rollups for any past days that don't have one yet. */
export async function backfillRollups(): Promise<{ generated: string[]; errors: Array<{ date: string; error: string }> }> {
  const missing = findMissingRollups();
  const generated: string[] = [];
  const errors: Array<{ date: string; error: string }> = [];
  for (const date of missing) {
    try {
      await generateRollup(date);
      generated.push(date);
    } catch (err: any) {
      errors.push({ date, error: err?.message ?? String(err) });
    }
  }
  return { generated, errors };
}

/** Schedule the next midnight write of yesterday's rollup. Re-schedules itself. */
export function scheduleMidnightRollup(): NodeJS.Timeout {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 30, 0);    // 30s past midnight to make sure the date has ticked over
  const ms = Math.max(60_000, next.getTime() - now.getTime());
  return setTimeout(async () => {
    try {
      // Roll up the day that just finished (now-2min, to be safe across DST/leap)
      const cutoff = new Date(Date.now() - 2 * 60_000);
      const date = ymd(cutoff);
      await generateRollup(date);
      console.log(`[history] wrote rollup for ${date}`);
    } catch (err) {
      console.warn(`[history] midnight rollup failed:`, err);
    }
    scheduleMidnightRollup();
  }, ms);
}

/** Initialise the rollup pipeline: backfill + schedule. Safe to call at startup. */
export async function startHistoryRollup(): Promise<void> {
  ensureDir(ROLLUP_DIR);
  const r = await backfillRollups();
  if (r.generated.length) console.log(`[history] backfilled ${r.generated.length} rollups: ${r.generated.join(', ')}`);
  if (r.errors.length)    console.warn(`[history] ${r.errors.length} rollups failed:`, r.errors);
  scheduleMidnightRollup();
}
