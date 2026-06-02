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
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname, networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { mikrotik, MtConnection, MtLease, MtArp, MtDnsCacheEntry } from './mikrotik-client.js';
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

/** Read today's JSONL snapshots. Each line is one minute's full snapshot. Cheap enough to re-read on every request. */
function readTodaySnapshots(): Array<{ ts: string; devices: MtLease[]; arp: MtArp[]; connections: MtConnection[]; }> {
  const path = todayJsonlPath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const out: Array<{ ts: string; devices: MtLease[]; arp: MtArp[]; connections: MtConnection[]; }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

export class NetworkService {
  private aliases: AliasMap = readJsonOrEmpty(ALIASES_PATH, {});
  private owners: OwnerMap = readJsonOrEmpty(OWNERS_PATH, {});
  private blocks: BlockState = readJsonOrEmpty(BLOCKS_PATH, {});
  private kidList: KidList = readJsonOrEmpty(KIDLIST_PATH, { macs: [] });
  private devicePolicy: DevicePolicyMap = readJsonOrEmpty(DEVICE_POLICY_PATH, {});
  // Per-kid auto-block rules added by the policy scanner: mac → hostname → ruleId(s)
  private kidAutoBlocks: Map<string, Map<string, string[]>> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private selfMacs: Set<string> = localHostMacs();
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
    try {
      const text = readFileSync(FLAGS_PATH, 'utf-8');
      return text.trim().split('\n')
        .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((r): r is Record<string, unknown> =>
          !!r && new Date(r.time as string).getTime() >= cutoff);
    } catch { return []; }
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
