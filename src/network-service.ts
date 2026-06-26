/**
 * Network monitoring + control service.
 *
 * Wraps the MikroTik client and the JSONL data the collector writes, exposing
 * the higher-level shape the dashboard wants:
 *   - per-device summary (online, vendor, today's bandwidth, top destinations, blocked state)
 *   - one-click block / unblock with optional scheduled expiry
 *   - persistent device aliases (friendly names the user types)
 *
 * No EventEmitter or WebSocket wiring here — that lives in the gateway. This
 * file is the data layer.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { homedir, hostname as osHostname, networkInterfaces } from 'node:os';

// Domain → category for the per-child activity log. Order matters: the
// "concerning" categories (concern=true) are tested first. These let a parent
// see WHAT a child did, grouped meaningfully, with risky activity surfaced.
const ACTIVITY_CATS: Array<[string, RegExp, boolean]> = [
  ['adult', /porn|xvid|xnxx|xham|brazz|onlyfans|nsfw|hentai|chaturb|redtube|youporn|spankbang|fapell|rule34|\bnude/i, true],
  ['proxy/vpn', /protonvpn|nordvpn|expressvpn|psiphon|unblock|croxyproxy|hidester|torproject|windscribe|mullvad|tunnelbear|hide\.me|\bvpn\b/i, true],
  ['ai-helper', /quillbot|prowritingaid|chegg|coursehero|chatgpt|character\.ai|janitorai|gauthmath|photomath|brainly|paraphras/i, true],
  ['gambling', /casino|bet365|pokerstars|sportsbet|roulette|gambl/i, true],
  ['dating/strangers', /omegle|ome\.tv|chatroulette|tinder|grindr|yubo|monkey\.app/i, true],
  ['social', /tiktok|instagram|snapchat|facebook|fbcdn|discord|reddit|twitter|x\.com|pinterest|threads|whatsapp/i, false],
  ['gaming', /roblox|rbxcdn|minecraft|epicgames|steampowered|fortnite|supercell|brawlstars|riotgames/i, false],
  ['video', /youtube|googlevideo|ytimg|netflix|nflxvideo|twitch|disney|primevideo|hulu|vimeo|dailymotion/i, false],
  ['search', /^google\.|bing\.com|duckduckgo|yahoo\.com/i, false],
];
function categorizeActivity(host: string): { category: string; concern: boolean } {
  for (const [name, rx, concern] of ACTIVITY_CATS) if (rx.test(host)) return { category: name, concern };
  return { category: 'other', concern: false };
}
import { createRequire } from 'node:module';
import { mikrotik, MtConnection, MtLease, MtArp, MtDnsCacheEntry } from './mikrotik-client.js';
import { dnsIndex } from './dns-index.js';
import { ipResolver } from './ip-name-resolver.js';
import { mdnsListener } from './mdns-listener.js';
// IEEE OUI registry, ~37k vendors keyed by 6-hex-digit prefix (no separators).
// Each value is a multi-line string; the first line is the vendor name.
// Loaded via createRequire so we don't need TS import-attribute support.
const ouiData = createRequire(import.meta.url)('oui-data') as Record<string, string>;

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const ALIASES_PATH = join(homedir(), '.claude-gombwe', 'network-aliases.json');
const OWNERS_PATH = join(homedir(), '.claude-gombwe', 'network-owners.json');
const BLOCKS_PATH = join(homedir(), '.claude-gombwe', 'network-blocks.json');
const KIDLIST_PATH = join(homedir(), '.claude-gombwe', 'network-kid-list.json');
const DEVICE_POLICY_PATH = join(homedir(), '.claude-gombwe', 'network-device-policy.json');
const POLICY_ACTIONS_PATH = join(homedir(), '.claude-gombwe', 'network-policy-actions.jsonl');
const FLAGS_PATH = join(homedir(), '.claude-gombwe', 'network-policy-flags.jsonl');
const DOSSIER_CACHE_PATH = join(homedir(), '.claude-gombwe', 'network-dossier-cache.json');

// Per-device blocked-category map. Default for adults: none.
// Default applied automatically when a device is added to the kid list:
//   adult + gambling + dangerous. Tweakable per device after that.
const KID_DEFAULT_CATEGORIES = ['adult', 'gambling', 'dangerous'];
type DevicePolicyMap = Record<string, { blockedCategories: string[]; updatedAt: string }>;

export interface DeviceSummary {
  mac: string;
  ip: string;
  name: string;
  hostname: string;
  vendor: string;
  model: string | null;         // mDNS-derived Apple model code, e.g. "Macmini9,1"
  model_friendly: string | null;// human form of the model code, e.g. "Mac mini (M1, 2020)"
  mdns_host: string | null;     // .local hostname from mDNS A/SRV
  mdns_name: string | null;     // friendly instance label from mDNS PTR (e.g. "Tendai's iPhone")
  mdns_category: string | null; // coarse device class: speaker, camera, printer, ...
  mdns_services: string[];      // Bonjour service types this device advertises
  self: boolean;                // true ⇢ this is the device gombwe is running on
  owner: string | null;       // Person who owns the device (set by user; null = household/unassigned)
  kid: boolean;               // On the kid list → AI policy scanner may auto-block for this device
  online: boolean;
  last_seen: string;
  active_connections: number;
  today_bytes_down: number;
  today_bytes_up: number;
  blocked: boolean;
  block_expires: string | null;
  top_destinations_today: Array<{ host: string; bytes: number; connections: number }>;
  blocked_categories: string[];     // per-device category enforcement (5b.2)
}

export interface NetworkStatus {
  router: { model: string; version: string; uptime: string; cpu_load: number };
  online_count: number;
  known_count: number;
  current_bandwidth: { down_mbps: number; up_mbps: number };
  active_conntrack: number;
  active_blocks: number;
  data_collector: { running: boolean; first_snapshot: string | null; snapshot_count: number };
}

interface AliasMap { [mac: string]: string; }
interface OwnerMap { [mac: string]: string; }
interface BlockState { [mac: string]: { rule_id: string; blocked_until: string | null; created_at: string; }; }
interface KidList { macs: string[]; }

/** Full IEEE OUI lookup, backed by the `oui-data` JSON registry (~37k vendors). */
const OUI_TABLE = ouiData;

function ouiOf(mac: string): string {
  // Locally-administered bit (second hex of first byte = 2,6,A,E) → MAC randomization (iOS/Android privacy)
  const first = parseInt(mac.slice(0, 2), 16);
  if (isNaN(first)) return 'Unknown';
  if ((first & 0x02) !== 0) return 'Randomized';
  // oui-data keys are uppercase, no separators, 6 hex digits.
  const key = mac.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6).toUpperCase();
  const entry = OUI_TABLE[key];
  if (!entry) return 'Unknown';
  // Entries are multi-line ("VENDOR\nADDRESS\nCITY\nCOUNTRY"). Vendor is line one.
  const vendor = entry.split('\n')[0].trim();
  return vendor || 'Unknown';
}

/** Collect this Mac's own MAC addresses so we can self-identify the host device. */
function localHostMacs(): Set<string> {
  const macs = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.mac && i.mac !== '00:00:00:00:00:00') macs.add(i.mac.toUpperCase());
    }
  }
  return macs;
}

/** This host's own LAN IPv4 addresses — reliable self-identification even when
 *  the router sees a randomized Wi-Fi MAC that os.networkInterfaces() doesn't. */
function localHostIps(): Set<string> {
  const ips = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && i.address) ips.add(i.address);
    }
  }
  return ips;
}

/** Clean `os.hostname()` for display: strip trailing .local, replace dashes with spaces nothing else. */
function selfDisplayName(): string {
  const raw = osHostname().replace(/\.local\.?$/i, '');
  // Keep the raw form (e.g. "tendais-Mac-mini") — users recognise this. They can rename in the UI.
  return raw || 'Mac mini · gombwe';
}

function readJsonOrEmpty<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as T : fallback; }
  catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function todayJsonlPath(): string {
  return join(DATA_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

// ── Parsed day-file cache ────────────────────────────────────────────
// Reading + splitting + JSON.parsing the multi-MB DNS / flow / snapshot day
// files on every dashboard poll and every 5s status broadcast was pegging the
// CPU (a `sample` profile was dominated by String.split, JSON.parse and V8's
// DateParser). Historical day files are immutable; only today's grows. Cache
// the parsed records keyed by (size, mtime) so repeated reads are free, and
// precompute a numeric `_tms` for the `ts` field so consumers never re-run
// `new Date(str)`. Bounded so the cache can't grow without limit.
export type JsonlRec = Record<string, unknown> & { _tms?: number };
const _dayFileCache = new Map<string, { sig: string; recs: JsonlRec[]; heap: number }>();
let _dayFileCacheHeap = 0;
// Parsed JS objects cost roughly 5× the on-disk JSON text in V8 heap. Bound the
// cache by ESTIMATED HEAP (not file bytes) — bounding by file size let 7-14 days
// of parsed day files accumulate past the ~2 GB V8 limit and OOM-crash the
// process. ~200 MB heap keeps today's hot files (re-read every 5s) cached with
// headroom for the dossier builders' transient working set.
const HEAP_PER_FILE_BYTE = 5;
const DAY_FILE_CACHE_MAX_HEAP = 150 * 1024 * 1024;

/**
 * Read a JSONL day file (optionally .gz) and return its parsed records, cached
 * by file size+mtime. Each record gets a numeric `_tms` if it has a string
 * `ts`. The returned array is shared — callers MUST treat records as read-only.
 */
function readJsonlCached(path: string): JsonlRec[] {
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return []; }
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = _dayFileCache.get(path);
  if (hit && hit.sig === sig) return hit.recs;

  let raw: string;
  try {
    raw = path.endsWith('.gz')
      ? gunzipSync(readFileSync(path)).toString('utf-8')
      : readFileSync(path, 'utf-8');
  } catch { return []; }

  const recs: JsonlRec[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r: JsonlRec;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = r.ts;
    if (typeof ts === 'string') r._tms = Date.parse(ts);
    recs.push(r);
  }

  const heap = st.size * HEAP_PER_FILE_BYTE;
  if (hit) _dayFileCacheHeap -= hit.heap;
  _dayFileCache.set(path, { sig, recs, heap });
  _dayFileCacheHeap += heap;
  // Evict oldest (insertion-ordered) entries until under the heap ceiling. Never
  // evict the entry we just inserted (a single oversized file may exceed it).
  while (_dayFileCacheHeap > DAY_FILE_CACHE_MAX_HEAP && _dayFileCache.size > 1) {
    const oldest = _dayFileCache.keys().next().value as string;
    if (oldest === path) break;
    _dayFileCacheHeap -= _dayFileCache.get(oldest)!.heap;
    _dayFileCache.delete(oldest);
  }
  return recs;
}

/** Read a DNS/flow/snapshot day file, transparently falling back to its .gz. */
function readDayRecs(path: string): JsonlRec[] {
  if (existsSync(path)) return readJsonlCached(path);
  if (existsSync(path + '.gz')) return readJsonlCached(path + '.gz');
  return [];
}

/** Read today's JSONL snapshots. Each line is one minute's full snapshot. Cached by mtime/size. */
function readTodaySnapshots(): Array<{ ts: string; devices: MtLease[]; arp: MtArp[]; connections: MtConnection[]; }> {
  return readDayRecs(todayJsonlPath()) as unknown as Array<{ ts: string; devices: MtLease[]; arp: MtArp[]; connections: MtConnection[]; }>;
}

export class NetworkService {
  private aliases: AliasMap = readJsonOrEmpty(ALIASES_PATH, {});
  private owners: OwnerMap = readJsonOrEmpty(OWNERS_PATH, {});
  private blocks: BlockState = readJsonOrEmpty(BLOCKS_PATH, {});
  private kidList: KidList = readJsonOrEmpty(KIDLIST_PATH, { macs: [] });
  private devicePolicy: DevicePolicyMap = readJsonOrEmpty(DEVICE_POLICY_PATH, {});
  // Pre-built dossiers (forensicTimeline is expensive + grows over time). The
  // background refresher rebuilds these; the endpoint serves the cache instantly.
  private dossierCache: Record<string, { builtAt: number; device: string; sessions: ReturnType<NetworkService['forensicTimeline']>['sessions'] }> = readJsonOrEmpty(DOSSIER_CACHE_PATH, {});
  // first-seen wall-clock per active connection key, for live strand "since".
  private strandSeen = new Map<string, number>();
  // Per-kid auto-block rules added by the policy scanner: mac → hostname → ruleId(s)
  private kidAutoBlocks: Map<string, Map<string, string[]>> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private selfMacs: Set<string> = localHostMacs();
  private selfIps: Set<string> = localHostIps();
  private selfName: string = selfDisplayName();

  constructor() {
    // On startup, re-arm scheduled-unblock timers for any blocks that still have a future expiry.
    for (const [mac, state] of Object.entries(this.blocks)) {
      if (state.blocked_until) {
        const remaining = new Date(state.blocked_until).getTime() - Date.now();
        if (remaining > 0) this.scheduleUnblock(mac, remaining);
        else this.unblock(mac).catch(() => { /* will retry next request */ });
      }
    }
  }

  // ── Status ─────────────────────────────────────────────────────
  async status(): Promise<NetworkStatus> {
    const [resource, leases, ifaces, conns] = await Promise.all([
      mikrotik.systemResource(),
      mikrotik.dhcpLeases(),
      mikrotik.interfaceStatsLive(),
      mikrotik.connections().catch(() => [] as MtConnection[]),
    ]);

    const onlineMacs = new Set(leases.filter(l => l.status === 'bound').map(l => l['mac-address']?.toUpperCase()).filter(Boolean));
    const knownMacs = new Set(leases.map(l => l['mac-address']?.toUpperCase()).filter(Boolean));

    // Sum up rx/tx bits/s across WAN-ish interfaces. ether1 is the conventional WAN port.
    const wan = ifaces.find(i => i.name === 'ether1');
    const downMbps = wan?.['rx-bits-per-second'] ? parseInt(wan['rx-bits-per-second']) / 1_000_000 : 0;
    const upMbps   = wan?.['tx-bits-per-second'] ? parseInt(wan['tx-bits-per-second']) / 1_000_000 : 0;

    const snapshots = readTodaySnapshots();

    return {
      router: {
        model: resource['board-name'] ?? 'unknown',
        version: resource.version ?? 'unknown',
        uptime: resource.uptime ?? '?',
        cpu_load: parseInt(resource['cpu-load'] ?? '0') || 0,
      },
      online_count: onlineMacs.size,
      known_count: knownMacs.size,
      current_bandwidth: { down_mbps: +downMbps.toFixed(2), up_mbps: +upMbps.toFixed(2) },
      active_conntrack: conns.length,
      // Manual device blocks currently in effect (excludes per-MAC category drops).
      active_blocks: Object.keys(this.blocks).length,
      data_collector: {
        running: snapshots.length > 0 && (Date.now() - new Date(snapshots[snapshots.length - 1].ts).getTime() < 5 * 60_000),
        first_snapshot: snapshots[0]?.ts ?? null,
        snapshot_count: snapshots.length,
      },
    };
  }

  // ── Devices ────────────────────────────────────────────────────
  async devices(): Promise<DeviceSummary[]> {
    const [leases, conns, dnsCache] = await Promise.all([
      mikrotik.dhcpLeases(),
      mikrotik.connections(),
      mikrotik.dnsCache().catch(() => [] as MtDnsCacheEntry[]),
    ]);

    // Build IP → hostname map from DNS cache, so we can show readable destinations.
    const ipToHost = new Map<string, string>();
    for (const e of dnsCache) {
      if (e.address && e.name) ipToHost.set(e.address, e.name);
    }

    // Aggregate today's connection bytes per (src_mac, dst_host) — but
    // CORRECTLY this time. Each snapshot reports each still-open connection's
    // *cumulative* byte counters; a 2-hour TCP session captured 120 times
    // would otherwise be counted 120× if we just summed. Instead, key every
    // unique connection by its 5-tuple and keep the MAX bytes seen (which
    // is the connection's final running total at the moment we last saw it).
    // Sum across unique connections at the end.
    const snapshots = readTodaySnapshots();

    // Per-connection: 5-tuple → {mac, host, up, down, hits}
    // - up   = max orig-bytes seen (device → outside)
    // - down = max repl-bytes seen (outside → device)
    // - hits = how many snapshots this connection appeared in (proxy for "session count")
    interface ConnTotal { mac: string; host: string; up: number; down: number; hits: number }
    const connTotals: Map<string, ConnTotal> = new Map();

    for (const snap of snapshots) {
      const ipToMac = new Map<string, string>();
      for (const lease of snap.devices) {
        if (lease.address && lease['mac-address']) ipToMac.set(lease.address, lease['mac-address'].toUpperCase());
      }
      for (const c of snap.connections) {
        const srcAddr = c['src-address'] ?? '';
        const dstAddr = c['dst-address'] ?? '';
        const srcIp = srcAddr.split(':')[0];
        const dstIp = dstAddr.split(':')[0];
        if (!srcIp || !dstIp) continue;
        const mac = ipToMac.get(srcIp);
        if (!mac) continue;
        const origBytes = parseInt(c['orig-bytes'] ?? '0') || 0;
        const replBytes = parseInt(c['repl-bytes'] ?? '0') || 0;

        // 5-tuple key: src_address (with port) + dst_address (with port) + protocol.
        // Distinct connections always have distinct 5-tuples on the same router until conntrack expires.
        const key = `${c.protocol ?? '?'}|${srcAddr}|${dstAddr}`;
        // Pick the most-specific destination name:
        //   1. MikroTik DNS cache (exact hostname the device queried)
        //   2. IpNameResolver (heuristic ranges first, then reverse DNS w/ caching)
        //   3. Raw IP (only if nothing resolved yet)
        const host = ipToHost.get(dstIp) ?? ipResolver().resolveSync(dstIp);

        const existing = connTotals.get(key);
        if (!existing) {
          connTotals.set(key, { mac, host, up: origBytes, down: replBytes, hits: 1 });
        } else {
          // Keep the max for each direction — counters only increase within a connection.
          if (origBytes > existing.up) existing.up = origBytes;
          if (replBytes > existing.down) existing.down = replBytes;
          existing.hits += 1;
        }
      }
    }

    // Now fold per-connection totals into per-MAC and per-destination summaries.
    const todayPerMac: Map<string, { down: number; up: number; dests: Map<string, { bytes: number; conns: number }> }> = new Map();
    for (const t of connTotals.values()) {
      const entry = todayPerMac.get(t.mac) ?? { down: 0, up: 0, dests: new Map() };
      entry.up   += t.up;
      entry.down += t.down;
      const d = entry.dests.get(t.host) ?? { bytes: 0, conns: 0 };
      d.bytes += t.up + t.down;
      d.conns += 1;   // one unique connection contributes one to the count, not one per snapshot
      entry.dests.set(t.host, d);
      todayPerMac.set(t.mac, entry);
    }

    const activeConnsByMac = new Map<string, number>();
    {
      const ipToMacNow = new Map<string, string>();
      for (const lease of leases) {
        if (lease.address && lease['mac-address']) ipToMacNow.set(lease.address, lease['mac-address'].toUpperCase());
      }
      for (const c of conns) {
        const srcIp = c['src-address']?.split(':')[0];
        if (!srcIp) continue;
        const mac = ipToMacNow.get(srcIp);
        if (!mac) continue;
        activeConnsByMac.set(mac, (activeConnsByMac.get(mac) ?? 0) + 1);
      }
    }

    const mdns = mdnsListener();

    const summaries: DeviceSummary[] = leases.map(lease => {
      const mac = (lease['mac-address'] ?? '').toUpperCase();
      const ip = lease.address ?? '';
      const hostname = lease['host-name'] ?? '';
      const today = todayPerMac.get(mac);
      const topDests = today
        ? [...today.dests.entries()]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .slice(0, 5)
            .map(([host, v]) => ({ host, bytes: v.bytes, connections: v.conns }))
        : [];
      const blockState = this.blocks[mac];
      const isSelf = this.selfMacs.has(mac);
      const mdnsHit = ip ? mdns.getByIp(ip) : undefined;

      // Name precedence (most authoritative → least):
      //   1. user alias (explicit rename)
      //   2. self  ⇢ os.hostname()  (we know our own device)
      //   3. mDNS friendly INSTANCE name (e.g. "Tendai's iPhone")
      //   4. mDNS .local hostname
      //   5. DHCP host-name
      //   6. MAC (last-resort fallback)
      const name =
        this.aliases[mac] ||
        (isSelf ? this.selfName : null) ||
        mdnsHit?.name ||
        mdnsHit?.host ||
        hostname ||
        mac;

      return {
        mac, ip,
        name,
        hostname,
        vendor: ouiOf(mac),
        model: mdnsHit?.model ?? null,
        model_friendly: mdnsHit?.model_friendly ?? null,
        mdns_host: mdnsHit?.host ?? null,
        mdns_name: mdnsHit?.name ?? null,
        mdns_category: mdnsHit?.category ?? null,
        mdns_services: mdnsHit?.services ?? [],
        self: isSelf,
        owner: this.owners[mac] ?? null,
        kid: this.isKid(mac),
        online: lease.status === 'bound',
        last_seen: new Date().toISOString(),  // refined when we have history
        active_connections: activeConnsByMac.get(mac) ?? 0,
        today_bytes_down: today?.down ?? 0,
        today_bytes_up: today?.up ?? 0,
        blocked: !!blockState,
        block_expires: blockState?.blocked_until ?? null,
        top_destinations_today: topDests,
        blocked_categories: this.devicePolicy[mac]?.blockedCategories ?? [],
      };
    });

    return summaries.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.today_bytes_down + b.today_bytes_up - (a.today_bytes_down + a.today_bytes_up);
    });
  }

  // ── Aliases ────────────────────────────────────────────────────
  setAlias(mac: string, name: string): void {
    const key = mac.toUpperCase();
    if (!name) delete this.aliases[key];
    else this.aliases[key] = name;
    writeJson(ALIASES_PATH, this.aliases);
  }

  // ── Owners (person assignment for person-first grouping) ───────
  setOwner(mac: string, owner: string | null): void {
    const key = mac.toUpperCase();
    if (!owner) delete this.owners[key];
    else this.owners[key] = owner;
    writeJson(OWNERS_PATH, this.owners);
  }

  // ── Kid list (per-device policy scoping) ──────────────────────
  isKid(mac: string): boolean {
    return this.kidList.macs.includes(mac.toUpperCase());
  }

  kidMacs(): string[] {
    return [...this.kidList.macs];
  }

  setKid(mac: string, on: boolean): void {
    const key = mac.toUpperCase();
    const set = new Set(this.kidList.macs);
    if (on) set.add(key); else set.delete(key);
    this.kidList.macs = [...set];
    writeJson(KIDLIST_PATH, this.kidList);
    // First time a device joins the kid list, seed its category policy with the
    // safe defaults. Subsequent kid-flag toggles don't touch policy — once you've
    // edited it, it stays edited.
    if (on && !this.devicePolicy[key]) {
      this.setDevicePolicy(key, KID_DEFAULT_CATEGORIES, 'kid-default');
    }
  }

  // ── Policy flags (detected, NOT blocked) ──────────────────────
  /**
   * Persist a policy *flag* from the scanner. Universal — works for any device,
   * kid-list or not. Surfaced by alerts() so the dashboard shows it and the user
   * can choose to block. Also mirrored into the policy-actions audit log so the
   * paper trail is in one place ("they can't say they never did it").
   */
  recordFlag(
    mac: string, name: string, hostname: string,
    severity: 'low' | 'med' | 'high', reason: string,
    category?: string, ip?: string,
  ): void {
    // NEVER flag the gombwe host itself. gombwe resolves flagged domains on
    // this host (enforceCategoryBlock → dns.resolve) to BLOCK them for kids,
    // which makes the host's DNS log mirror exactly what it's blocking. Flagging
    // that would falsely accuse the host (e.g. pornhub appearing on the Mac at
    // the same second the Chromebook hit it). Self = infrastructure, not a user.
    if (this.selfMacs.has(mac.toUpperCase()) || (ip && this.selfIps.has(ip))) return;
    const rec = {
      time: new Date().toISOString(),
      action: 'flagged',
      mac: mac.toUpperCase(),
      name, hostname, severity, reason,
      category: category ?? null,
      ip: ip ?? null,
    };
    try { appendFileSync(FLAGS_PATH, JSON.stringify(rec) + '\n', { mode: 0o600 }); }
    catch (err) { console.warn('[network] recordFlag failed:', err); }
    this.writePolicyAction(rec);
  }

  /** Recent flags within the window (hours), newest last. */
  recentFlags(hours = 48): Array<Record<string, unknown>> {
    const cutoff = Date.now() - hours * 3600_000;
    return this.allFlags().filter(r => new Date(r.time as string).getTime() >= cutoff);
  }

  /** Every flag ever recorded (the permanent breach record), oldest first. */
  allFlags(): Array<Record<string, unknown>> {
    try {
      const text = readFileSync(FLAGS_PATH, 'utf-8');
      return text.trim().split('\n')
        .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((r): r is Record<string, unknown> => !!r && !!r.time);
    } catch { return []; }
  }

  /**
   * Breach dossier — the full flag history grouped per device into a case file.
   * Append-only and independent of banner dismissal: this is the permanent
   * record. Each device lists its flagged hostnames (count + first/last seen +
   * worst severity), plus per-category and per-severity tallies.
   */
  dossier(): {
    generatedAt: string;
    totalFlags: number;
    devices: Array<{
      mac: string; name: string; total: number;
      firstSeen: string; lastSeen: string;
      bySeverity: Record<string, number>;
      byCategory: Record<string, number>;
      hosts: Array<{ hostname: string; category: string | null; severity: string; count: number; firstSeen: string; lastSeen: string; reason: string }>;
    }>;
  } {
    const flags = this.allFlags();
    const sevWeight = (s: unknown) => ({ high: 3, med: 2, medium: 2, low: 1 } as Record<string, number>)[String(s || '').toLowerCase()] || 0;
    const byDevice = new Map<string, Record<string, unknown>[]>();
    for (const f of flags) {
      const mac = String(f.mac || f.ip || 'unknown').toUpperCase();
      if (!byDevice.has(mac)) byDevice.set(mac, []);
      byDevice.get(mac)!.push(f);
    }
    const devices = [...byDevice.entries()].map(([mac, fs]) => {
      const bySeverity: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      const hostMap = new Map<string, { hostname: string; category: string | null; severity: string; count: number; firstSeen: string; lastSeen: string; reason: string }>();
      let firstSeen = '', lastSeen = '', name = mac;
      for (const f of fs) {
        const sev = String(f.severity || 'low').toLowerCase();
        const cat = (f.category as string) ?? 'uncategorized';
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
        byCategory[cat] = (byCategory[cat] || 0) + 1;
        const t = String(f.time || '');
        if (!firstSeen || t < firstSeen) firstSeen = t;
        if (!lastSeen || t > lastSeen) lastSeen = t;
        if (f.name) name = String(f.name);
        const h = String(f.hostname || '?');
        const ex = hostMap.get(h);
        if (ex) {
          ex.count++;
          if (t < ex.firstSeen) ex.firstSeen = t;
          if (t > ex.lastSeen) ex.lastSeen = t;
          if (sevWeight(sev) > sevWeight(ex.severity)) ex.severity = sev;
        } else {
          hostMap.set(h, { hostname: h, category: (f.category as string) ?? null, severity: sev, count: 1, firstSeen: t, lastSeen: t, reason: String(f.reason || '') });
        }
      }
      const hosts = [...hostMap.values()].sort((a, b) => sevWeight(b.severity) - sevWeight(a.severity) || (b.lastSeen).localeCompare(a.lastSeen));
      return { mac, name, total: fs.length, firstSeen, lastSeen, bySeverity, byCategory, hosts };
    });
    // worst-offender first: by highest-severity count, then total
    devices.sort((a, b) => (b.bySeverity.high || 0) - (a.bySeverity.high || 0) || b.total - a.total);
    return { generatedAt: new Date().toISOString(), totalFlags: flags.length, devices };
  }

  // ── Usage dossier (per-device session/byte ledger) ────────────
  /**
   * Per-device usage dossier from connection records. Source per day:
   *   B (preferred): flows-YYYY-MM-DD.jsonl from the NetFlow collector — exact.
   *   A (fallback):  reconstructed from the 60s conntrack snapshots (DAY.jsonl)
   *                  for days before NetFlow was enabled (coarser, 60s grain).
   * Aggregates each LAN device's sessions + bytes, with its top destinations.
   * Destinations are by IP for now (human-readable names need DNS-answer
   * capture — a separate enhancement).
   */
  usageDossier(days = 7): {
    generatedAt: string; days: number; source: string;
    devices: Array<{
      ip: string; name: string; totalBytes: number; bytesUp: number; bytesDown: number;
      sessions: number; firstSeen: string; lastSeen: string; auditFlags?: number;
      destinations: Array<{ remote: string; host?: string | null; bytes: number; bytesUp: number; bytesDown: number; sessions: number; dur_s: number; firstSeen: string; lastSeen: string; flagged?: string | null }>;
    }>;
  } {
    const LAN = '192.168.88.';

    // Flagged-hostname set from the audit journal — to icon "bad" destinations.
    // Only genuine concerns (severity med+) within the window: the AI scanner's
    // low-severity "youtube is social media" notes must not paint the dossier red.
    const sevRank = (s: string) => ({ high: 3, med: 2, medium: 2, low: 1 } as Record<string, number>)[s] || 0;
    const flagCutoffMs = Date.now() - days * 86400_000;
    const flaggedHosts = new Map<string, string>();
    for (const f of this.allFlags()) {
      const sev = String(f.severity || 'low').toLowerCase();
      if (sevRank(sev) < 2) continue;
      if (new Date(String(f.time || '')).getTime() < flagCutoffMs) continue;
      const h = String(f.hostname || '').toLowerCase(); if (!h) continue;
      if (sevRank(sev) > sevRank(flaggedHosts.get(h) || '')) flaggedHosts.set(h, sev);
    }

    type Dest = { remote: string; up: number; down: number; sessions: number; dur_s: number; firstSeen: string; lastSeen: string };
    const devs = new Map<string, { name: string; up: number; down: number; sessions: number; firstSeen: string; lastSeen: string; dests: Map<string, Dest> }>();

    // up = bytes the LAN device SENT, down = bytes it RECEIVED.
    const addFlow = (lanIp: string, remote: string, up: number, down: number, durS: number, start: string, end: string) => {
      let d = devs.get(lanIp);
      if (!d) { d = { name: lanIp, up: 0, down: 0, sessions: 0, firstSeen: start, lastSeen: end, dests: new Map() }; devs.set(lanIp, d); }
      d.up += up; d.down += down; d.sessions++;
      if (start < d.firstSeen) d.firstSeen = start;
      if (end > d.lastSeen) d.lastSeen = end;
      let de = d.dests.get(remote);
      if (!de) { de = { remote, up: 0, down: 0, sessions: 0, dur_s: 0, firstSeen: start, lastSeen: end }; d.dests.set(remote, de); }
      de.up += up; de.down += down; de.sessions++; de.dur_s += durS;
      if (start < de.firstSeen) de.firstSeen = start;
      if (end > de.lastSeen) de.lastSeen = end;
    };
    const ipOnly = (s: string) => (s || '').split(':')[0];

    let usedNetflow = false, usedSnapshots = false;
    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const flowPath = join(DATA_DIR, `flows-${day}.jsonl`);
      if (existsSync(flowPath)) {
        usedNetflow = true;
        for (const f of readDayRecs(flowPath)) {
          const src = String(f.src || ''), dst = String(f.dst || '');
          const bytes = Number(f.bytes || 0), dur = Number(f.dur_s || 0);
          const start = String(f.start || f.ts || ''), end = String(f.end || f.ts || '');
          // NetFlow flows are unidirectional: src->dst with `bytes`.
          if (src.startsWith(LAN)) addFlow(src, dst, bytes, 0, dur, start, end);        // device sent
          else if (dst.startsWith(LAN)) addFlow(dst, src, 0, bytes, dur, start, end);   // device received
        }
      } else {
        // A: reconstruct from conntrack snapshots (orig=src->dst, repl=dst->src).
        const snapPath = join(DATA_DIR, `${day}.jsonl`);
        if (!existsSync(snapPath)) continue;
        usedSnapshots = true;
        const conns = new Map<string, { src: string; dst: string; orig: number; repl: number; first: string; last: string }>();
        for (const s of readDayRecs(snapPath) as Array<{ ts?: string; connections?: Array<Record<string, unknown>> }>) {
          const ts = s.ts || '';
          for (const c of s.connections || []) {
            const src = ipOnly(String(c['src-address'] || '')), dst = ipOnly(String(c['dst-address'] || ''));
            if (!src || !dst) continue;
            const orig = Number(c['orig-bytes'] || 0), repl = Number(c['repl-bytes'] || 0);
            const key = `${c['src-address']}|${c['dst-address']}|${c.protocol}`;
            const ex = conns.get(key);
            if (ex) { ex.orig = Math.max(ex.orig, orig); ex.repl = Math.max(ex.repl, repl); ex.last = ts; }
            else conns.set(key, { src, dst, orig, repl, first: ts, last: ts });
          }
        }
        for (const c of conns.values()) {
          const dur = Math.max(0, Math.round((new Date(c.last).getTime() - new Date(c.first).getTime()) / 1000));
          // conntrack src initiated: orig = its upload, repl = its download.
          if (c.src.startsWith(LAN)) addFlow(c.src, c.dst, c.orig, c.repl, dur, c.first, c.last);
          else if (c.dst.startsWith(LAN)) addFlow(c.dst, c.src, c.repl, c.orig, dur, c.first, c.last);
        }
      }
    }

    const result = [...devs.entries()].map(([ip, d]) => ({
      ip, name: d.name, totalBytes: d.up + d.down, bytesUp: d.up, bytesDown: d.down,
      sessions: d.sessions, firstSeen: d.firstSeen, lastSeen: d.lastSeen,
      destinations: [...d.dests.values()]
        .sort((a, b) => (b.up + b.down) - (a.up + a.down)).slice(0, 20)
        .map(de => {
          const host = dnsIndex().lookup(de.remote);
          return {
            remote: de.remote, host,
            bytes: de.up + de.down, bytesUp: de.up, bytesDown: de.down,
            sessions: de.sessions, dur_s: de.dur_s, firstSeen: de.firstSeen, lastSeen: de.lastSeen,
            flagged: host ? (flaggedHosts.get(host.toLowerCase()) ?? null) : null,
          };
        }),
    })).sort((a, b) => b.totalBytes - a.totalBytes);
    const source = usedNetflow && usedSnapshots ? 'netflow+snapshots' : usedNetflow ? 'netflow' : usedSnapshots ? 'snapshots' : 'none';
    return { generatedAt: new Date().toISOString(), days, source, devices: result };
  }

  /** Attach friendly device names to a usage dossier using the SAME precedence
   *  as the device list (user alias → DHCP host-name → IP), so names are
   *  consistent everywhere (e.g. "Liam-Chromebook", not the serial). */
  async nameUsageDevices(dossier: ReturnType<NetworkService['usageDossier']>): Promise<ReturnType<NetworkService['usageDossier']>> {
    try {
      const leases = await mikrotik.dhcpLeases();
      const ipToMac = new Map<string, string>();
      const ipToHost = new Map<string, string>();
      for (const l of leases) {
        if (!l.address) continue;
        if (l['mac-address']) ipToMac.set(l.address, l['mac-address'].toUpperCase());
        ipToHost.set(l.address, l['host-name'] || l.comment || '');
      }
      // count GENUINE audit flags per MAC (severity med+, within the dossier
      // window) — so "X in audit" reflects real concerns and matches the
      // activity view, not the scanner's low-severity social/video noise.
      const sevRank = (s: string) => ({ high: 3, med: 2, medium: 2, low: 1 } as Record<string, number>)[s] || 0;
      const cutoffMs = Date.now() - (dossier.days || 7) * 86400_000;
      // distinct flagged hostnames per MAC — the scanner re-flags the same site
      // every cycle, so count unique concerns, not raw flag lines.
      const flaggedSitesByMac = new Map<string, Set<string>>();
      for (const f of this.allFlags()) {
        const m = String(f.mac || '').toUpperCase(); if (!m) continue;
        if (sevRank(String(f.severity || 'low').toLowerCase()) < 2) continue;
        if (new Date(String(f.time || '')).getTime() < cutoffMs) continue;
        const h = String(f.hostname || '').toLowerCase(); if (!h) continue;
        if (!flaggedSitesByMac.has(m)) flaggedSitesByMac.set(m, new Set());
        flaggedSitesByMac.get(m)!.add(h);
      }
      for (const d of dossier.devices) {
        const mac = ipToMac.get(d.ip);
        d.name = (mac && this.aliases[mac]) || ipToHost.get(d.ip) || d.name;
        if (mac && flaggedSitesByMac.has(mac)) d.auditFlags = flaggedSitesByMac.get(mac)!.size;
      }
    } catch { /* leave IPs */ }
    return dossier;
  }

  // ── Activity log (what a device did online, over time) ────────
  /**
   * Per-device online-activity log from the DNS history (names + times), up to
   * `days` back. Attribution is MAC-accurate over time (the device's IP changes
   * across the window — reconstructed from snapshots). Lookups are grouped into
   * domain "visits" (same registrable domain within a 10-min gap), categorised,
   * and risky categories (adult/proxy-vpn/ai-helper/gambling/dating) flagged.
   * This is the "precisely what is this child doing online" view.
   */
  activityLog(mac: string, days = 7, flaggedOnly = false): {
    device: string; days: number; totalVisits: number; concerning: number;
    visits: Array<{ domain: string; category: string; concern: boolean; inAudit: boolean; first: string; last: string; count: number; down: number; up: number }>;
  } {
    const target = mac.toUpperCase();
    const name = this.aliases[target] || target;
    // 1. MAC → IP intervals from snapshots (change-points), for time-accurate attribution
    const changes: Array<[string, string]> = [];  // [ts, ip]
    let lastIp: string | null = null;
    // Rolling window by absolute time (not calendar day). DNS files are named
    // by UTC date, but the window is Melbourne-relative wall-clock, so read one
    // EXTRA day of files and filter records to >= cutoff. This stops the
    // day-boundary bug where "today" (AEST morning) hides in yesterday's UTC file.
    const cutoffMs = Date.now() - days * 86400_000;
    const sevRank = (s: string) => ({ high: 3, med: 2, medium: 2, low: 1 } as Record<string, number>)[s] || 0;
    const dayStrs: string[] = [];
    for (let i = days; i >= 0; i--) dayStrs.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
    for (const day of dayStrs) {
      const snap = join(DATA_DIR, `${day}.jsonl`);
      for (const s of readDayRecs(snap) as Array<{ ts?: string; devices?: Array<Record<string, unknown>> }>) {
        for (const d of s.devices || []) {
          if (String(d['mac-address'] || '').toUpperCase() === target && d.address && d.address !== lastIp) {
            changes.push([s.ts || '', String(d.address)]); lastIp = String(d.address);
          }
        }
      }
    }
    const ipAt = (ts: string): string | null => {
      if (!changes.length) return null;
      let ip = changes[0][1];
      for (const [t, p] of changes) { if (t <= ts) ip = p; else break; }
      return ip;
    };
    // flagged-domain set from the audit journal — for THIS device only
    const auditDomains = new Set<string>();
    const reg = (h: string) => { const p = h.split('.'); return p.length >= 2 ? p.slice(-2).join('.') : h; };
    for (const f of this.allFlags()) {
      if (String(f.mac || '').toUpperCase() !== target) continue;
      if (sevRank(String(f.severity || 'low').toLowerCase()) < 2) continue;       // med+ only — no scanner noise
      if (new Date(String(f.time || '')).getTime() < cutoffMs) continue;          // within window
      const h = String(f.hostname || ''); if (h) auditDomains.add(reg(h).toLowerCase());
    }

    // 2. read DNS day files, attribute, collect (domain, ts). Use the cached
    //    reader + precomputed `_tms` so we don't re-read/re-parse the multi-MB
    //    day files or re-`new Date()` every record on each call.
    type Visit = { domain: string; category: string; concern: boolean; inAudit: boolean; first: string; last: string; count: number; down: number; up: number };
    type TsRec = { tms: number; ts: string };
    const byDomain = new Map<string, TsRec[]>();  // domain -> records (sorted later)
    for (const day of dayStrs) {
      for (const r of readDayRecs(join(DATA_DIR, `dns-${day}.jsonl`)) as Array<JsonlRec & { client_ip?: string; hostname?: string }>) {
        const tms = r._tms ?? NaN;
        const ts = r.ts as string | undefined;
        if (!r.hostname || !ts || !(tms >= cutoffMs) || r.client_ip !== ipAt(ts)) continue;
        const dom = reg(String(r.hostname)).toLowerCase();
        let arr = byDomain.get(dom); if (!arr) { arr = []; byDomain.set(dom, arr); }
        arr.push({ tms, ts });
      }
    }
    // 3. aggregate into visits (10-min gap splits a visit)
    const GAP = 10 * 60 * 1000;
    const visits: Visit[] = [];
    for (const [dom, recs] of byDomain) {
      recs.sort((a, b) => a.tms - b.tms);
      const cat = categorizeActivity(dom);
      const inAudit = auditDomains.has(dom);
      let vs = recs[0], prev = recs[0], cnt = 0;
      const push = (first: TsRec, last: TsRec, count: number) =>
        visits.push({ domain: dom, category: cat.category, concern: cat.concern, inAudit, first: first.ts, last: last.ts, count, down: 0, up: 0 });
      for (const r of recs) {
        if (r.tms - prev.tms > GAP) { push(vs, prev, cnt); vs = r; cnt = 0; }
        prev = r; cnt++;
      }
      push(vs, prev, cnt);
    }

    // 3b. Attach data volume (↓/↑) to each visit by correlating flow records
    //     (NetFlow + snapshot bytes) to the domain (via dns-index) within the
    //     visit's time window. Byte coverage is best for recent days; older /
    //     unnamed-IP traffic stays 0 (shown as "—" in the UI).
    const domFlows = new Map<string, Array<{ up: number; down: number; t0: number; t1: number }>>();
    const remoteDom = (ip: string): string | null => { const h = dnsIndex().lookup(ip); return h ? reg(h).toLowerCase() : null; };
    const addDF = (dom: string | null, up: number, down: number, t0: string, t1: string) => {
      if (!dom) return;
      if (!domFlows.has(dom)) domFlows.set(dom, []);
      domFlows.get(dom)!.push({ up, down, t0: new Date(t0).getTime(), t1: new Date(t1).getTime() });
    };
    for (const day of dayStrs) {
      const fp = join(DATA_DIR, `flows-${day}.jsonl`);
      if (existsSync(fp)) {
        for (const f of readDayRecs(fp)) {
          const s = String(f.src || ''), dd = String(f.dst || ''), b = Number(f.bytes || 0);
          const st = String(f.start || f.ts || ''), en = String(f.end || f.ts || '');
          if (s === ipAt(st)) addDF(remoteDom(dd), b, 0, st, en);
          else if (dd === ipAt(st)) addDF(remoteDom(s), 0, b, st, en);
        }
      } else {
        const sp = join(DATA_DIR, `${day}.jsonl`);
        const conns = new Map<string, { src: string; dst: string; orig: number; repl: number; first: string; last: string }>();
        for (const s of readDayRecs(sp) as Array<{ ts?: string; connections?: Array<Record<string, unknown>> }>) {
          const ts = s.ts || '';
          for (const c of s.connections || []) {
            const src = String(c['src-address'] || '').split(':')[0], dst = String(c['dst-address'] || '').split(':')[0];
            if (!src || !dst) continue;
            const key = `${c['src-address']}|${c['dst-address']}|${c.protocol}`;
            const orig = Number(c['orig-bytes'] || 0), repl = Number(c['repl-bytes'] || 0);
            const ex = conns.get(key);
            if (ex) { ex.orig = Math.max(ex.orig, orig); ex.repl = Math.max(ex.repl, repl); ex.last = ts; }
            else conns.set(key, { src, dst, orig, repl, first: ts, last: ts });
          }
        }
        for (const c of conns.values()) {
          if (c.src === ipAt(c.first)) addDF(remoteDom(c.dst), c.orig, c.repl, c.first, c.last);
          else if (c.dst === ipAt(c.first)) addDF(remoteDom(c.src), c.repl, c.orig, c.first, c.last);
        }
      }
    }
    for (const v of visits) {
      const fs = domFlows.get(v.domain);
      if (!fs) continue;
      const vf = new Date(v.first).getTime() - GAP, vl = new Date(v.last).getTime() + GAP;
      for (const f of fs) if (f.t1 >= vf && f.t0 <= vl) { v.up += f.up; v.down += f.down; }
    }
    // "Flagged" = a genuinely-concerning category (adult/proxy-vpn/ai-helper/
    // gambling/dating). inAudit stays as a marker but doesn't drive the filter,
    // so the scanner's low-severity "youtube is social media" notes don't bury
    // the real risks.
    let out = visits;
    if (flaggedOnly) out = out.filter(v => v.concern);
    out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    return {
      device: name, days,
      totalVisits: visits.length,
      concerning: visits.filter(v => v.concern).length,
      visits: out.slice(0, 500),
    };
  }

  // ── Forensic dossier (sequenced concerning sessions, evidence-grade) ──
  /**
   * A clean, chronological evidence timeline for one device: only the
   * CONCERNING categories (adult / proxy-vpn / gambling / dating / ai-helper),
   * grouped into sessions (>30-min gap = new session), each with its duration,
   * data downloaded (correlated from flow/snapshot bytes), and the biggest
   * source. MAC-accurate across IP changes; gombwe host excluded implicitly
   * (it's never one of the device's IPs). This is what a parent screenshots.
   */
  forensicTimeline(mac: string, days = 14): {
    device: string; days: number; generatedAt: string;
    sessions: Array<{ start: string; end: string; durationSec: number; category: string; severity: string; domains: string[]; lookups: number; bytesDown: number; topSource: string | null }>;
  } {
    const target = mac.toUpperCase();
    const name = this.aliases[target] || target;
    const cutoffMs = Date.now() - days * 86400_000;
    const dayStrs: string[] = [];
    for (let i = days; i >= 0; i--) dayStrs.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
    // MAC → IP change-points
    const changes: Array<[string, string]> = []; let lastIp: string | null = null;
    for (const day of dayStrs) {
      for (const s of readDayRecs(join(DATA_DIR, `${day}.jsonl`)) as Array<{ ts?: string; devices?: Array<Record<string, unknown>> }>) {
        for (const d of s.devices || []) if (String(d['mac-address'] || '').toUpperCase() === target && d.address && d.address !== lastIp) { changes.push([s.ts || '', String(d.address)]); lastIp = String(d.address); }
      }
    }
    const ipAt = (ts: string): string | null => { if (!changes.length) return null; let ip = changes[0][1]; for (const [t, p] of changes) { if (t <= ts) ip = p; else break; } return ip; };
    const reg = (h: string) => { const p = h.split('.'); return p.length >= 2 ? p.slice(-2).join('.') : h; };
    // concerning lookups
    type Hit = { t: number; iso: string; cat: string; dom: string };
    const hits: Hit[] = [];
    for (const day of dayStrs) {
      for (const r of readDayRecs(join(DATA_DIR, `dns-${day}.jsonl`)) as Array<JsonlRec & { client_ip?: string; hostname?: string }>) {
        const ts = r.ts as string | undefined;
        if (!r.hostname || !ts) continue;
        const tms = r._tms ?? NaN; if (!(tms >= cutoffMs)) continue;
        if (r.client_ip !== ipAt(ts)) continue;
        const c = categorizeActivity(String(r.hostname));
        // Dossier = the damning categories only. ai-helper (homework tools) is a
        // separate concern and runs all-day, which would bloat sessions + bytes.
        if (!c.concern || c.category === 'ai-helper') continue;
        hits.push({ t: tms, iso: ts, cat: c.category, dom: reg(String(r.hostname)).toLowerCase() });
      }
    }
    hits.sort((a, b) => a.t - b.t);
    // sessionize per category (30-min gap)
    type Sess = { category: string; start: string; end: string; tStart: number; tEnd: number; domains: Set<string>; lookups: number };
    const sessions: Sess[] = []; const open: Record<string, Sess | undefined> = {};
    for (const h of hits) {
      const s = open[h.cat];
      if (s && h.t - s.tEnd <= 1800_000) { s.tEnd = h.t; s.end = h.iso; s.domains.add(h.dom); s.lookups++; }
      else { if (s) sessions.push(s); open[h.cat] = { category: h.cat, start: h.iso, end: h.iso, tStart: h.t, tEnd: h.t, domains: new Set([h.dom]), lookups: 1 }; }
    }
    for (const k in open) if (open[k]) sessions.push(open[k]!);
    const sevOf = (c: string) => c === 'adult' ? 'high' : (c === 'proxy/vpn' || c === 'gambling' || c === 'dating/strangers') ? 'med' : 'low';
    const out = sessions.map(s => {
      // VPN = an engagement/bypass event; its window-bytes are concurrent other
      // traffic (misleading), so don't attribute bytes to it.
      const isVpn = s.category === 'proxy/vpn';
      const { dl, top, activeMs } = isVpn ? { dl: 0, top: null, activeMs: 0 } : this.deviceDownloadInWindow(ipAt, s.tStart - 120_000, s.tEnd + 1200_000);
      const durationSec = Math.max(Math.round((s.tEnd - s.tStart) / 1000), Math.round(activeMs / 1000));
      return { start: s.start, end: s.end, durationSec, category: s.category, severity: sevOf(s.category), domains: [...s.domains], lookups: s.lookups, bytesDown: dl, topSource: top };
    }).sort((a, b) => (a.start < b.start ? 1 : -1));
    return { device: name, days, generatedAt: new Date().toISOString(), sessions: out };
  }

  /** Download bytes (+biggest source) to the device during [t0ms,t1ms], from
   *  NetFlow when present else conntrack snapshots. ipAt gives the device IP at a time. */
  private deviceDownloadInWindow(ipAt: (ts: string) => string | null, t0ms: number, t1ms: number): { dl: number; top: string | null; activeMs: number } {
    const days = new Set<string>();
    for (let t = t0ms; t <= t1ms; t += 3600_000) days.add(new Date(t).toISOString().slice(0, 10));
    days.add(new Date(t1ms).toISOString().slice(0, 10));
    let dl = 0; const bydst = new Map<string, number>();
    let tmin = Infinity, tmax = 0;   // span of byte-bearing activity (≈ viewing time)
    for (const day of days) {
      const fp = join(DATA_DIR, `flows-${day}.jsonl`);
      if (existsSync(fp)) {
        for (const f of readDayRecs(fp)) {
          const startStr = String(f.start || f.ts);
          const st = (f.start ? Date.parse(startStr) : (f._tms ?? Date.parse(startStr))); if (st < t0ms || st > t1ms) continue;
          if (f.dst === ipAt(startStr)) { const b = Number(f.bytes || 0); dl += b; bydst.set(String(f.src), (bydst.get(String(f.src)) || 0) + b);
            if (b > 50_000) { const et = new Date(String(f.end || f.start)).getTime(); tmin = Math.min(tmin, st); tmax = Math.max(tmax, et); } } }
      } else {
        const sp = join(DATA_DIR, `${day}.jsonl`);
        const conns = new Map<string, { dst: string; repl: number }>();
        for (const s of readDayRecs(sp) as Array<JsonlRec & { ts?: string; connections?: Array<Record<string, unknown>> }>) {
          const tms = s._tms ?? NaN; if (!(tms >= t0ms) || tms > t1ms) continue;
          const ip = ipAt(String(s.ts || ''));
          for (const c of s.connections || []) { const src = String(c['src-address'] || '').split(':')[0], dst = String(c['dst-address'] || '').split(':')[0];
            if (src === ip) { const k = `${c['src-address']}|${c['dst-address']}`; const repl = Number(c['repl-bytes'] || 0); const ex = conns.get(k); if (!ex || repl > ex.repl) conns.set(k, { dst, repl });
              if (repl > 50_000) { tmin = Math.min(tmin, tms); tmax = Math.max(tmax, tms); } } } }
        for (const v of conns.values()) { dl += v.repl; bydst.set(v.dst, (bydst.get(v.dst) || 0) + v.repl); }
      }
    }
    let top: string | null = null, tb = 0; for (const [d, b] of bydst) if (b > tb) { tb = b; top = d; }
    return { dl, top: top ? `${top} · ${(tb / 1048576).toFixed(0)} MB` : null, activeMs: tmax > tmin ? tmax - tmin : 0 };
  }

  /** Rebuild + persist the dossier cache for one device (full 90-day window). */
  rebuildDossier(mac: string): void {
    const key = mac.toUpperCase();
    const t = this.forensicTimeline(key, 90);
    this.dossierCache[key] = { builtAt: Date.now(), device: t.device, sessions: t.sessions };
    try { writeJson(DOSSIER_CACHE_PATH, this.dossierCache); } catch { /* keep in memory */ }
  }

  /** Serve a dossier from cache (filtered to the requested window), building
   *  it live only if never cached. This keeps the endpoint instant. */
  getDossier(mac: string, days: number): { device: string; days: number; generatedAt: string; cached: boolean; sessions: ReturnType<NetworkService['forensicTimeline']>['sessions'] } {
    const key = mac.toUpperCase();
    let c = this.dossierCache[key]; let cached = true;
    if (!c) { this.rebuildDossier(key); c = this.dossierCache[key]; cached = false; }
    const cutoff = Date.now() - days * 86400_000;
    const sessions = (c.sessions || []).filter(s => new Date(s.start).getTime() >= cutoff);
    return { device: c.device, days, generatedAt: new Date(c.builtAt).toISOString(), cached, sessions };
  }

  /** Background refresh: rebuild dossiers for devices whose concerning history
   *  has actually changed (so the cache stays warm). Called on a timer.
   *
   *  The forensic dossier is built purely from CONCERNING (flagged) DNS, so a
   *  device's dossier cannot change unless it has a flag newer than its last
   *  build. Gating on that turns this sweep from "re-read 90 days × every
   *  flagged device, every 15 min" (which pegged the CPU and froze the gateway)
   *  into near-zero work on a quiet network. Yields between rebuilds so a cold
   *  build never blocks the event loop / HTTP server. */
  async refreshAllDossiers(): Promise<void> {
    const newestFlag = new Map<string, number>();
    for (const f of this.allFlags()) {
      const m = String(f.mac || '').toUpperCase(); if (!m || this.selfMacs.has(m)) continue;
      const t = Date.parse(String(f.time || '')); if (!Number.isFinite(t)) continue;
      if (t > (newestFlag.get(m) ?? 0)) newestFlag.set(m, t);
    }
    for (const [m, newest] of newestFlag) {
      if (newest <= (this.dossierCache[m]?.builtAt ?? 0)) continue;   // nothing new since last build
      try { this.rebuildDossier(m); } catch { /* skip a bad device */ }
      await new Promise(r => setImmediate(r));                        // yield to the event loop
    }
  }

  // ── Live strands (every active session as an inspectable thread) ──
  /**
   * Every currently-active connection as a "strand": which device, to where
   * (named), bytes up/down, how long it's been open (since), protocol, state,
   * whether it's flagged, and whether it's currently cut (blocked). This is the
   * data behind the coloured-strands router view.
   */
  async liveStrands(): Promise<{
    generatedAt: string;
    devices: Array<{ ip: string; mac: string; name: string }>;
    strands: Array<{
      id: string; deviceIp: string; deviceMac: string; deviceName: string;
      dst: string; dstHost: string | null; proto: string; dport: number;
      up: number; down: number; total: number; state: string;
      since: string; flagged: string | null; cut: boolean;
    }>;
  }> {
    const LAN = '192.168.88.';
    const [conns, leases, rules] = await Promise.all([
      mikrotik.connections(), mikrotik.dhcpLeases(), mikrotik.filterRules().catch(() => []),
    ]);
    const ipToMac = new Map<string, string>(), ipToName = new Map<string, string>();
    for (const l of leases) {
      if (!l.address) continue;
      const mac = (l['mac-address'] || '').toUpperCase();
      ipToMac.set(l.address, mac);
      ipToName.set(l.address, (mac && this.aliases[mac]) || l['host-name'] || l.comment || l.address);
    }
    // which (mac,dstIp) pairs are currently cut by a strand-cut rule
    const cutSet = new Set<string>();
    for (const r of rules) {
      const m = /gombwe-strand-cut mac=([0-9A-Fa-f:]+) dst=([0-9.a-fA-F:]+)/.exec(r.comment || '');
      if (m && r.disabled !== 'true') cutSet.add(`${m[1].toUpperCase()}|${m[2]}`);
    }
    const flaggedHosts = new Map<string, string>();
    const sevRank = (s: string) => ({ high: 3, med: 2, medium: 2, low: 1 } as Record<string, number>)[s] || 0;
    for (const f of this.allFlags()) {
      const h = String(f.hostname || '').toLowerCase(); if (!h) continue;
      const sev = String(f.severity || 'low').toLowerCase();
      if (sevRank(sev) > sevRank(flaggedHosts.get(h) || '')) flaggedHosts.set(h, sev);
    }
    const ipOnly = (s: string) => (s || '').split(':')[0];
    const portOf = (s: string) => parseInt((s || '').split(':')[1] || '0', 10);
    const now = Date.now();
    const seenKeys = new Set<string>();
    const devices = new Map<string, { ip: string; mac: string; name: string }>();
    const strands: Awaited<ReturnType<NetworkService['liveStrands']>>['strands'] = [];

    for (const c of conns) {
      const srcIp = ipOnly(c['src-address'] || ''), dstIp = ipOnly(c['dst-address'] || '');
      let devIp = '', remote = '', up = 0, down = 0;
      if (srcIp.startsWith(LAN)) { devIp = srcIp; remote = dstIp; up = Number(c['orig-bytes'] || 0); down = Number(c['repl-bytes'] || 0); }
      else if (dstIp.startsWith(LAN)) { devIp = dstIp; remote = srcIp; up = Number(c['repl-bytes'] || 0); down = Number(c['orig-bytes'] || 0); }
      else continue;
      if (!remote || remote.startsWith(LAN)) continue;          // skip LAN-internal
      const key = `${c['src-address']}|${c['dst-address']}|${c.protocol}`;
      seenKeys.add(key);
      let since = this.strandSeen.get(key);
      if (!since) { since = now; this.strandSeen.set(key, since); }
      const mac = ipToMac.get(devIp) || '';
      const name = ipToName.get(devIp) || devIp;
      if (!devices.has(devIp)) devices.set(devIp, { ip: devIp, mac, name });
      const host = dnsIndex().lookup(remote);
      strands.push({
        id: key, deviceIp: devIp, deviceMac: mac, deviceName: name,
        dst: remote, dstHost: host, proto: c.protocol || '', dport: portOf(c['dst-address'] || ''),
        up, down, total: up + down, state: c['tcp-state'] || '',
        since: new Date(since).toISOString(),
        flagged: host ? (flaggedHosts.get(host.toLowerCase()) ?? null) : null,
        cut: cutSet.has(`${mac}|${remote}`),
      });
    }
    // prune first-seen entries for connections that closed
    for (const k of this.strandSeen.keys()) if (!seenKeys.has(k)) this.strandSeen.delete(k);
    strands.sort((a, b) => b.total - a.total);
    return { generatedAt: new Date().toISOString(), devices: [...devices.values()], strands };
  }

  /** Cut a strand: block this device→destination and kill the live connection. */
  async cutStrand(deviceIp: string, dstIp: string): Promise<{ ruleId: string; killed: number }> {
    const leases = await mikrotik.dhcpLeases();
    const lease = leases.find(l => l.address === deviceIp);
    const mac = (lease?.['mac-address'] || '').toUpperCase();
    if (!mac) throw new Error(`no MAC for ${deviceIp}`);
    const ruleId = await mikrotik.addDstBlockForMac(mac, dstIp, `gombwe-strand-cut mac=${mac} dst=${dstIp}`);
    const killed = await mikrotik.killConnectionsBetween(deviceIp, dstIp);
    return { ruleId, killed };
  }

  /** Reconnect a strand: remove the strand-cut rule for this device→destination. */
  async reconnectStrand(deviceIp: string, dstIp: string): Promise<{ removed: number }> {
    const leases = await mikrotik.dhcpLeases();
    const mac = (leases.find(l => l.address === deviceIp)?.['mac-address'] || '').toUpperCase();
    const rules = await mikrotik.filterRules();
    let removed = 0;
    for (const r of rules) {
      if ((r.comment || '').includes(`gombwe-strand-cut mac=${mac} dst=${dstIp}`)) {
        await mikrotik.removeRule(r['.id']); removed++;
      }
    }
    return { removed };
  }

  // ── Per-device category policy ────────────────────────────────
  getDevicePolicy(mac: string): { blockedCategories: string[]; updatedAt: string | null } {
    const key = mac.toUpperCase();
    const p = this.devicePolicy[key];
    if (!p) return { blockedCategories: [], updatedAt: null };
    return { blockedCategories: [...p.blockedCategories], updatedAt: p.updatedAt };
  }

  setDevicePolicy(mac: string, categories: string[], reason: string = 'manual'): void {
    const key = mac.toUpperCase();
    const cleaned = Array.from(new Set(categories.map(c => String(c).toLowerCase()).filter(Boolean))).sort();
    const previous = this.devicePolicy[key]?.blockedCategories || [];
    this.devicePolicy[key] = { blockedCategories: cleaned, updatedAt: new Date().toISOString() };
    writeJson(DEVICE_POLICY_PATH, this.devicePolicy);
    // Audit-log the change so the Audit subtab + future "why was this blocked?"
    // forensics have a paper trail.
    this.writePolicyAction({
      time: new Date().toISOString(),
      action: 'policy-changed',
      mac: key,
      name: this.aliases[key] ?? key,
      categories_now: cleaned,
      categories_before: previous,
      reason,
      severity: 'info',
    });
  }

  /** Convenience for the enforcement path — is this category blocked for this device? */
  isCategoryBlockedFor(mac: string, category: string): boolean {
    const key = mac.toUpperCase();
    return this.devicePolicy[key]?.blockedCategories.includes(category.toLowerCase()) ?? false;
  }

  /**
   * Per-device category enforcement primitive used by category-enforcer.
   * Resolves the hostname, adds dst-IP drop rules tagged to this MAC,
   * kills active conntrack flows, and audit-logs the attempt.
   *
   * Sibling to autoBlockHostnameForKid but NOT gated on kid-list membership —
   * any device with the category in its policy gets enforced.
   *
   * If knownIp is provided (from the DNS answer in the log), we skip the
   * stdlib resolve and use it directly — much faster.
   */
  async enforceCategoryBlock(
    mac: string, hostname: string, category: string, knownIp?: string,
  ): Promise<{ ips: string[]; rule_ids: string[]; killed: number }> {
    const key = mac.toUpperCase();

    let allIps: string[] = [];
    if (knownIp) {
      allIps = [knownIp];
    } else {
      const dns = await import('node:dns');
      const ips: string[] = await new Promise(r => dns.resolve4(hostname, (err, a) => r(err ? [] : a)));
      const ips6: string[] = await new Promise(r => dns.resolve6(hostname, (err, a) => r(err ? [] : a)));
      allIps = [...ips, ...ips6];
    }

    const ruleIds: string[] = [];
    for (const ip of allIps) {
      try {
        const id = await mikrotik.addDstBlockForMac(
          key, ip,
          `gombwe-cat ${category} mac=${this.aliases[key] ?? key} host=${hostname}`,
        );
        ruleIds.push(id);
      } catch (err) {
        console.warn(`[network] addDstBlockForMac (category) failed for ${key}→${ip}:`, err);
      }
    }

    let killed = 0;
    try {
      const leases = await mikrotik.dhcpLeases();
      const lease = leases.find(l => l['mac-address']?.toUpperCase() === key && l.status === 'bound');
      if (lease?.address) {
        // Targeted kills only — leave the kid's other apps alone.
        for (const ip of allIps) killed += await mikrotik.killConnectionsBetween(lease.address, ip);
      }
    } catch { /* best-effort */ }

    this.writePolicyAction({
      time: new Date().toISOString(),
      action: 'blocked-by-category',
      mac: key,
      name: this.aliases[key] ?? key,
      hostname,
      category,
      ips: allIps,
      rule_ids: ruleIds,
      killed_flows: killed,
      severity: category === 'dangerous' ? 'high' : 'med',
    });

    return { ips: allIps, rule_ids: ruleIds, killed };
  }

  // ── Block / Unblock ────────────────────────────────────────────
  /** Append a structured record to the policy-actions audit log. Used by
   *  every block/unblock path (manual + scanner-driven) so the Audit subtab
   *  has a complete history. */
  /** Public wrapper so external modules (schedule webhook etc.) can append
   *  to the same audit feed the policy-scanner and category-enforcer use. */
  writeAudit(rec: Record<string, unknown>): void {
    this.writePolicyAction(rec);
  }

  private writePolicyAction(rec: Record<string, unknown>): void {
    try {
      appendFileSync(POLICY_ACTIONS_PATH, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (err) {
      console.warn('[network] writePolicyAction failed:', err);
    }
  }

  async block(mac: string, durationMinutes: number | null): Promise<{ rule_id: string; blocked_until: string | null; killed_flows: number }> {
    const key = mac.toUpperCase();
    // If already blocked, unblock first to avoid duplicate firewall rules.
    if (this.blocks[key]) await this.unblock(key);

    const name = this.aliases[key] ?? key;
    const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60_000) : null;
    const comment = `gombwe-block ${name}${expiresAt ? ` until ${expiresAt.toISOString()}` : ' indefinite'}`;
    const ruleId = await mikrotik.addMacBlock(key, comment);

    // Find the device's current IP so we can also sever live connections.
    // The drop rule alone only stops NEW packets; for true preemption we
    // remove conntrack entries for this device's IP. Best-effort — missing
    // lease just means no active flows to kill.
    let killed = 0;
    try {
      const leases = await mikrotik.dhcpLeases();
      const lease = leases.find(l => l['mac-address']?.toUpperCase() === key && l.status === 'bound');
      if (lease?.address) {
        killed = await mikrotik.killConnectionsFromIp(lease.address);
      }
    } catch (err) {
      console.warn(`[network] block: kill-active-flows for ${key} failed:`, err);
    }

    this.blocks[key] = {
      rule_id: ruleId,
      blocked_until: expiresAt?.toISOString() ?? null,
      created_at: new Date().toISOString(),
    };
    writeJson(BLOCKS_PATH, this.blocks);

    if (expiresAt) this.scheduleUnblock(key, expiresAt.getTime() - Date.now());

    // Log to audit — manual blocks now appear in the Audit subtab alongside
    // the policy-scanner's auto-blocks.
    this.writePolicyAction({
      ts: new Date().toISOString(),
      mac: key,
      name: this.aliases[key] ?? null,
      action: 'block',
      severity: 'manual',
      reason: durationMinutes ? `Manual pause for ${durationMinutes} minutes` : 'Manual block (indefinite)',
      duration_minutes: durationMinutes,
      killed_flows: killed,
    });

    return { rule_id: ruleId, blocked_until: this.blocks[key].blocked_until, killed_flows: killed };
  }

  /**
   * Used by the policy scanner: block a specific hostname for one kid device.
   * Scoped per-MAC, so adult devices on the same network are unaffected.
   * Resolves the hostname to its current IPs, adds a per-MAC drop rule per IP,
   * kills any active connections to those IPs from the kid's device,
   * persists the action for audit.
   */
  async autoBlockHostnameForKid(mac: string, hostname: string, reason: string, severity: 'low'|'med'|'high'): Promise<{ rule_ids: string[]; ips: string[]; killed: number }> {
    const key = mac.toUpperCase();
    if (!this.isKid(key)) {
      throw new Error(`autoBlockHostnameForKid: ${key} is not on the kid list`);
    }

    // Resolve the hostname to its current IPs. Use Node's stdlib resolver
    // rather than asking MikroTik — that way we don't pollute the MikroTik
    // DNS cache with a query we're about to deny.
    const dns = await import('node:dns');
    const ips: string[] = await new Promise(resolve => {
      dns.resolve4(hostname, (err, addrs) => resolve(err ? [] : addrs));
    });
    // IPv6 too, best-effort
    const ips6: string[] = await new Promise(resolve => {
      dns.resolve6(hostname, (err, addrs) => resolve(err ? [] : addrs));
    });
    const allIps = [...ips, ...ips6];

    const ruleIds: string[] = [];
    for (const ip of allIps) {
      try {
        const id = await mikrotik.addDstBlockForMac(key, ip, `gombwe-auto kid=${this.aliases[key] ?? key} host=${hostname} severity=${severity}`);
        ruleIds.push(id);
      } catch (err) {
        console.warn(`[policy] addDstBlockForMac failed for ${key}→${ip}:`, err);
      }
    }

    // Track so we can remove later (e.g. on un-flag)
    const macMap = this.kidAutoBlocks.get(key) ?? new Map();
    macMap.set(hostname, ruleIds);
    this.kidAutoBlocks.set(key, macMap);

    // Kill any active sessions from this kid's device.
    let killed = 0;
    try {
      const leases = await mikrotik.dhcpLeases();
      const lease = leases.find(l => l['mac-address']?.toUpperCase() === key && l.status === 'bound');
      if (lease?.address) {
        killed = await mikrotik.killConnectionsFromIp(lease.address);
      }
    } catch { /* best-effort */ }

    // Persist for audit / dashboard "what got blocked, why, when"
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        mac: key,
        name: this.aliases[key] ?? null,
        hostname,
        reason,
        severity,
        ips: allIps,
        rule_ids: ruleIds,
        killed_flows: killed,
      });
      const { appendFileSync } = await import('node:fs');
      appendFileSync(POLICY_ACTIONS_PATH, line + '\n', { mode: 0o600 });
    } catch (err) { console.warn('[policy] write audit failed:', err); }

    return { rule_ids: ruleIds, ips: allIps, killed };
  }

  /** Return the recent policy actions journal (newest last). */
  policyActions(limit = 200): Array<Record<string, unknown>> {
    try {
      const text = readFileSync(POLICY_ACTIONS_PATH, 'utf-8');
      const lines = text.trim().split('\n').slice(-limit);
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
    } catch { return []; }
  }

  /**
   * Active alerts derived from MikroTik data. Replaces the eero-driven
   * detectors for flapping devices etc. — consumes the snapshot JSONL the
   * snapshot-collector writes every 60s.
   *
   * Currently detects:
   *   - flapping-device: more than FLAPPING_THRESHOLD bound/not-bound
   *     transitions in the last 24h
   *
   * Returns alert objects in the same shape as the legacy eero alerts so the
   * dashboard can render them through one banner code path.
   */
  alerts(): Array<{
    id: string; type: string; severity: 'info' | 'warning' | 'error';
    title: string; detail: string; suggestion?: string;
    firstSeen: string; lastSeen: string;
    data?: Record<string, unknown>;
  }> {
    const FLAPPING_THRESHOLD = 25;   // bumped from the eero default of 10
                                     // — phones and TVs commonly hit 15-20
                                     // in normal use; only flag truly bad ones
    const out: ReturnType<NetworkService['alerts']> = [];
    out.push(...this.detectFlappingFromSnapshots(FLAPPING_THRESHOLD));
    out.push(...this.flagsAsAlerts());
    return out;
  }

  /** Turn recent policy flags into dashboard alert banners. Grouped per
   *  device+hostname so repeated lookups collapse into one actionable alert. */
  private flagsAsAlerts(): ReturnType<NetworkService['alerts']> {
    // Breaches are a paper trail — keep them on the banner for 14 days, not just
    // the 24h a transient alert gets. (The full history lives in the audit log.)
    const FLAG_ALERT_WINDOW_HOURS = 24 * 14;
    const grouped = new Map<string, { count: number; first: string; last: string; rec: Record<string, unknown> }>();
    for (const f of this.recentFlags(FLAG_ALERT_WINDOW_HOURS)) {
      const key = `${f.mac}|${f.hostname}`;
      const g = grouped.get(key);
      if (g) { g.count++; g.last = f.time as string; }
      else grouped.set(key, { count: 1, first: f.time as string, last: f.time as string, rec: f });
    }
    const out: ReturnType<NetworkService['alerts']> = [];
    for (const [key, g] of grouped) {
      const r = g.rec;
      out.push({
        id: `flag:${key}`,
        type: 'policy-flag',
        severity: r.severity === 'high' ? 'error' : 'warning',
        title: `Flagged: ${r.hostname} on ${r.name}`,
        detail: `${r.reason}${r.category ? ` (${r.category})` : ''} — ${g.count}×, last seen ${(g.last || '').slice(0, 16).replace('T', ' ')} UTC`,
        suggestion: 'Review and block this host/device if it’s inappropriate.',
        firstSeen: g.first,
        lastSeen: g.last,
        data: { mac: r.mac, hostname: r.hostname, severity: r.severity, category: r.category, ip: r.ip },
      });
    }
    return out;
  }

  /** Walk the last 24h of snapshot JSONL, count bound/not-bound transitions
   *  per MAC, return flapping alerts above the threshold. Reads today's +
   *  yesterday's files because a 24h window straddles midnight half the day. */
  private detectFlappingFromSnapshots(threshold: number): ReturnType<NetworkService['alerts']> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const todayPath = todayJsonlPath();
    const yest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yestPath = join(DATA_DIR, `${yest}.jsonl`);

    const snapshots: Array<{ ts: string; devices: MtLease[] }> = [];
    for (const path of [yestPath, todayPath]) {
      if (!existsSync(path)) continue;
      try {
        const text = readFileSync(path, 'utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const snap = JSON.parse(line);
            if (!snap?.ts) continue;
            if (new Date(snap.ts).getTime() < cutoff) continue;
            snapshots.push({ ts: snap.ts, devices: snap.devices || [] });
          } catch { /* malformed line, skip */ }
        }
      } catch { /* unreadable file, skip */ }
    }
    if (snapshots.length < 2) return [];

    // For each MAC, walk snapshots and count state transitions.
    // State = 'bound' is online; anything else (waiting, expired, missing) is offline.
    interface FlapState {
      online: number;   // not-bound → bound transitions
      offline: number;  // bound → not-bound transitions
      lastState: 'bound' | 'offline' | null;
      first: string;
      last: string;
      name?: string;
    }
    const perMac = new Map<string, FlapState>();

    for (const snap of snapshots) {
      const seenThisSnap = new Set<string>();
      for (const lease of snap.devices) {
        const mac = (lease['mac-address'] || '').toUpperCase();
        if (!mac) continue;
        const state: 'bound' | 'offline' = lease.status === 'bound' ? 'bound' : 'offline';
        seenThisSnap.add(mac);
        const cur = perMac.get(mac) ?? { online: 0, offline: 0, lastState: null, first: snap.ts, last: snap.ts };
        if (cur.lastState !== null && cur.lastState !== state) {
          if (state === 'bound') cur.online += 1;
          else cur.offline += 1;
        }
        cur.lastState = state;
        cur.last = snap.ts;
        if (snap.ts < cur.first) cur.first = snap.ts;
        if (lease['host-name']) cur.name = lease['host-name'];
        perMac.set(mac, cur);
      }
      // MACs that disappear from a snapshot (not in DHCP at all) count as offline
      for (const [mac, cur] of perMac) {
        if (seenThisSnap.has(mac)) continue;
        if (cur.lastState === 'bound') {
          cur.offline += 1;
          cur.lastState = 'offline';
          cur.last = snap.ts;
        }
      }
    }

    const alerts: ReturnType<NetworkService['alerts']> = [];
    for (const [mac, t] of perMac) {
      const total = t.online + t.offline;
      if (total < threshold) continue;
      const alias = this.aliases[mac];
      const name = alias ?? t.name ?? mac;
      alerts.push({
        id: `flapping:${mac}`,
        type: 'flapping-device',
        severity: total >= threshold * 2 ? 'warning' : 'info',
        title: `${name} is flapping`,
        detail: `${total} online/offline transitions in the last 24 hours (${t.online} up, ${t.offline} down).`,
        suggestion: 'Likely weak Wi-Fi signal or aggressive client power-saving. For TVs and phones this is often normal. For laptops/desktops, check signal strength or consider a DHCP reservation.',
        firstSeen: t.first,
        lastSeen: t.last,
        data: { mac, count: total, online: t.online, offline: t.offline },
      });
    }
    return alerts;
  }

  async unblock(mac: string): Promise<void> {
    const key = mac.toUpperCase();
    const state = this.blocks[key];
    if (!state) return;
    await mikrotik.removeRule(state.rule_id);
    delete this.blocks[key];
    writeJson(BLOCKS_PATH, this.blocks);
    const t = this.timers.get(key);
    if (t) { clearTimeout(t); this.timers.delete(key); }

    // Log to audit so unblock events show in the Audit subtab.
    this.writePolicyAction({
      ts: new Date().toISOString(),
      mac: key,
      name: this.aliases[key] ?? null,
      action: 'unblock',
      severity: 'manual',
      reason: 'Manual unblock',
    });
  }

  private scheduleUnblock(mac: string, delayMs: number): void {
    const prev = this.timers.get(mac);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.unblock(mac).catch(err => console.error(`[network] scheduled unblock failed for ${mac}: ${err}`));
    }, delayMs);
    this.timers.set(mac, t);
  }
}

/** Lazy singleton — gateway constructs it after `mikrotik.load()`. */
let _instance: NetworkService | null = null;
export function getNetworkService(): NetworkService {
  if (!_instance) _instance = new NetworkService();
  return _instance;
}
