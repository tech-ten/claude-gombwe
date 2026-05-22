/**
 * MikroTik REST API client.
 * Talks to the router over HTTPS with HTTP Basic auth.
 * Credentials live in ~/.claude-gombwe/mikrotik.json (created by setup).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';

interface MtCreds { host: string; user: string; password: string; }

// MikroTik record types (only the fields we use).
export interface MtLease {
  '.id': string;
  address?: string;
  'mac-address'?: string;
  'host-name'?: string;
  status?: string;            // 'bound' | 'waiting' | …
  comment?: string;
  'expires-after'?: string;
  server?: string;
}

export interface MtArp {
  '.id': string;
  address?: string;
  'mac-address'?: string;
  interface?: string;
  complete?: string;          // 'true' | 'false'
}

export interface MtConnection {
  '.id': string;
  'src-address'?: string;     // "ip:port" for tcp/udp, "ip" for icmp
  'dst-address'?: string;
  protocol?: string;
  'orig-bytes'?: string;
  'repl-bytes'?: string;
  'orig-packets'?: string;
  'repl-packets'?: string;
  'tcp-state'?: string;
  timeout?: string;
}

export interface MtFirewallRule {
  '.id': string;
  '.about'?: string;
  chain?: string;
  action?: string;
  protocol?: string;
  'src-mac-address'?: string;
  'src-address'?: string;
  'dst-address'?: string;
  'dst-port'?: string;
  'src-port'?: string;
  time?: string;             // e.g., "21h-7h,mon,tue,wed,thu,fri"
  comment?: string;
  disabled?: string;
  invalid?: string;
  bytes?: string;
  packets?: string;
}

export interface MtScheduler {
  '.id': string;
  name?: string;
  'start-date'?: string;
  'start-time'?: string;
  interval?: string;
  'next-run'?: string;
  'on-event'?: string;
  comment?: string;
  disabled?: string;
  'run-count'?: string;
}

export interface MtNatRule {
  '.id': string;
  chain?: string;
  action?: string;
  protocol?: string;
  'dst-port'?: string;
  'to-addresses'?: string;
  'to-ports'?: string;
  'in-interface'?: string;
  'in-interface-list'?: string;
  comment?: string;
  disabled?: string;
  bytes?: string;
  packets?: string;
}

export interface MtSystemResource {
  version?: string;
  'board-name'?: string;
  uptime?: string;
  'cpu-load'?: string;
  'free-memory'?: string;
  'total-memory'?: string;
}

export interface MtInterfaceStats {
  '.id': string;
  name?: string;
  type?: string;
  running?: string;
  disabled?: string;
  'mac-address'?: string;
  mtu?: string;
  'rx-byte'?: string;
  'tx-byte'?: string;
  'rx-packet'?: string;
  'tx-packet'?: string;
  'rx-error'?: string;
  'tx-error'?: string;
  'rx-drop'?: string;
  'tx-drop'?: string;
  'rx-bits-per-second'?: string;
  'tx-bits-per-second'?: string;
  'last-link-up-time'?: string;
  'last-link-down-time'?: string;
}

export interface MtDnsCacheEntry {
  '.id': string;
  name?: string;
  address?: string;
  ttl?: string;
  type?: string;              // 'A' | 'AAAA' | …
}

const CREDS_PATH = join(homedir(), '.claude-gombwe', 'mikrotik.json');

export class MikroTikClient {
  private creds: MtCreds | null = null;
  private authHeader = '';

  /** Load creds from disk. Returns false if config missing — caller decides how to handle. */
  load(): boolean {
    if (!existsSync(CREDS_PATH)) return false;
    const cfg = JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as MtCreds;
    if (!cfg.host || !cfg.user || !cfg.password) return false;
    this.creds = cfg;
    this.authHeader = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    return true;
  }

  get configured(): boolean { return this.creds !== null; }
  get host(): string { return this.creds?.host ?? ''; }

  /**
   * HTTPS request to the router. We use `https.request` rather than `fetch`
   * because Node's fetch (undici) doesn't honour the `agent` option and the
   * MikroTik's self-signed cert with key-cert-sign+tls-server combined usage
   * trips fetch's strict cert-purpose check. https.request with
   * rejectUnauthorized:false works fine and is honest about what we're doing.
   */
  /**
   * Escape hatch for the Raw API subtab — lets the UI hit any /rest path.
   * Anything risky (write methods on dangerous resources) is gated in the
   * gateway, not here, because this method is also used internally by all
   * the other typed helpers and shouldn't second-guess them.
   */
  raw<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.req<T>(method, path, body);
  }

  private req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.creds) return Promise.reject(new Error('MikroTik client not configured (run setup first)'));
    const data = body !== undefined ? JSON.stringify(body) : null;
    return new Promise<T>((resolve, reject) => {
      const req = httpsRequest({
        host: this.creds!.host,
        port: 443,
        path: `/rest${path}`,
        method,
        rejectUnauthorized: false,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
        },
        timeout: 10_000,
      }, res => {
        let chunks = '';
        res.setEncoding('utf-8');
        res.on('data', c => { chunks += c; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try { resolve(chunks ? JSON.parse(chunks) as T : (null as T)); }
            catch (e) { reject(new Error(`MikroTik ${method} ${path}: invalid JSON response — ${(e as Error).message}`)); }
          } else {
            reject(new Error(`MikroTik ${method} ${path} → ${status}: ${chunks.slice(0, 400)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error(`MikroTik ${method} ${path} timed out`)); });
      if (data) req.write(data);
      req.end();
    });
  }

  // ── Read methods ───────────────────────────────────────────────
  systemResource = () => this.req<MtSystemResource>('GET', '/system/resource');
  dhcpLeases    = () => this.req<MtLease[]>('GET', '/ip/dhcp-server/lease');

  // ── NAT (port forwards live here) ───────────────────────────
  natRules = () => this.req<MtNatRule[]>('GET', '/ip/firewall/nat');
  async addPortForward(args: { srcPort: number; dstAddress: string; dstPort: number; protocol: 'tcp' | 'udp'; comment: string }): Promise<string> {
    const created = await this.req<{ '.id': string }>('PUT', '/ip/firewall/nat', {
      chain: 'dstnat',
      action: 'dst-nat',
      protocol: args.protocol,
      'in-interface-list': 'WAN',
      'dst-port': String(args.srcPort),
      'to-addresses': args.dstAddress,
      'to-ports': String(args.dstPort),
      comment: args.comment,
    });
    return created['.id'];
  }
  async removeNatRule(id: string): Promise<void> {
    try { await this.req('DELETE', `/ip/firewall/nat/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return;
      throw e;
    }
  }

  // ── DHCP reservations (static leases) ───────────────────────
  async addStaticLease(args: { mac: string; address: string; comment: string; server?: string }): Promise<string> {
    // RouterOS treats a manually-added lease as static automatically.
    const body: Record<string, string> = {
      'mac-address': args.mac.toUpperCase(),
      address: args.address,
      comment: args.comment,
    };
    if (args.server) body.server = args.server;
    const created = await this.req<{ '.id': string }>('PUT', '/ip/dhcp-server/lease', body);
    return created['.id'];
  }
  async removeLease(id: string): Promise<void> {
    try { await this.req('DELETE', `/ip/dhcp-server/lease/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return;
      throw e;
    }
  }
  /** Convert an existing dynamic lease (the device asked for an IP via DHCP) into a static one. */
  async makeLeaseStatic(id: string): Promise<void> {
    await this.req('POST', `/ip/dhcp-server/lease/make-static`, { numbers: id });
  }

  // ── System scheduler (used by the Schedule subtab) ──────────
  //
  // RouterOS scheduler fires `on-event` scripts at a configured time +
  // interval. We use it for per-MAC recurring block/unblock so schedules
  // survive even when gombwe is offline.
  //
  // Weekday filtering is done by creating one scheduler per active weekday
  // with interval=7d and start-date set to the next occurrence — RouterOS
  // does the day arithmetic. The unblock is a single daily scheduler
  // because removing a non-existent rule is a no-op.
  schedulers = () => this.req<MtScheduler[]>('GET', '/system/scheduler');

  async addScheduler(args: { name: string; startTime: string; startDate?: string; interval: string; onEvent: string; comment: string }): Promise<string> {
    const body: Record<string, string> = {
      name: args.name,
      'start-time': args.startTime,
      interval: args.interval,
      'on-event': args.onEvent,
      comment: args.comment,
    };
    if (args.startDate) body['start-date'] = args.startDate;
    const created = await this.req<{ '.id': string }>('PUT', '/system/scheduler', body);
    return created['.id'];
  }

  async removeScheduler(id: string): Promise<void> {
    try { await this.req('DELETE', `/system/scheduler/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return;
      throw e;
    }
  }
  arpTable      = () => this.req<MtArp[]>('GET', '/ip/arp');
  connections   = () => this.req<MtConnection[]>('GET', '/ip/firewall/connection');
  filterRules   = () => this.req<MtFirewallRule[]>('GET', '/ip/firewall/filter');
  dnsCache      = () => this.req<MtDnsCacheEntry[]>('GET', '/ip/dns/cache');
  interfaceStats = () => this.req<MtInterfaceStats[]>('GET', '/interface');

  /**
   * Same as interfaceStats() but synthesises rx-bits-per-second /
   * tx-bits-per-second from the delta between successive calls.
   *
   * RouterOS only populates the live bps fields via the `monitor-traffic`
   * action; the bare `GET /interface` returns cumulative byte counters
   * only. Calling monitor-traffic per interface every poll would add a
   * lot of round-trips, so we compute the rate client-side from the
   * cumulative counters we already have.
   *
   * First call returns 0 for bps (no previous sample to subtract from);
   * subsequent calls return real rates.
   */
  private lastIfaceSample = new Map<string, { rxByte: number; txByte: number; ts: number }>();
  async interfaceStatsLive(): Promise<MtInterfaceStats[]> {
    const now = Date.now();
    const samples = await this.interfaceStats();
    for (const i of samples) {
      if (!i.name) continue;
      const rxByte = parseInt(i['rx-byte'] || '0') || 0;
      const txByte = parseInt(i['tx-byte'] || '0') || 0;
      const prev = this.lastIfaceSample.get(i.name);
      if (prev && now > prev.ts) {
        const dt = (now - prev.ts) / 1000;
        if (dt > 0) {
          // Math.max(0, …) guards against counter resets (interface bounce,
          // router reboot mid-poll) which would otherwise show absurd rates.
          i['rx-bits-per-second'] = String(Math.max(0, Math.round((rxByte - prev.rxByte) * 8 / dt)));
          i['tx-bits-per-second'] = String(Math.max(0, Math.round((txByte - prev.txByte) * 8 / dt)));
        }
      }
      this.lastIfaceSample.set(i.name, { rxByte, txByte, ts: now });
    }
    return samples;
  }

  // ── Block / unblock ───────────────────────────────────────────
  /** Add a forward-chain drop rule for a given MAC. Returns the new rule's .id. */
  async addMacBlock(mac: string, comment: string): Promise<string> {
    const created = await this.req<MtFirewallRule>('PUT', '/ip/firewall/filter', {
      chain: 'forward',
      'src-mac-address': mac,
      action: 'drop',
      comment,
      // Place at the top of the chain so it actually takes effect.
      // (RouterOS evaluates filter rules in order; default rules near the bottom would otherwise let traffic through.)
      // The REST API doesn't accept `place-before` on creation in v7 reliably;
      // we'll position-via-move below.
    });
    if (created['.id']) {
      // Move to the top so it precedes the default established/related rule.
      try { await this.req('POST', '/ip/firewall/filter/move', { numbers: created['.id'], destination: '0' }); }
      catch { /* not fatal if move fails — rule still works as a generic drop */ }
    }
    return created['.id'];
  }

  // ── DNS adlist (network-wide blocklist subscriptions, RouterOS 7.7+) ─
  //
  // /ip/dns/adlist takes a URL pointing to a hosts/AdBlock-format file;
  // MikroTik fetches it periodically and returns NXDOMAIN for any matched
  // hostname. Effective network-wide because our DNS hijack forces all
  // clients to use MikroTik DNS (DoH/DoT egress is firewalled).

  async listAdlists(): Promise<Array<{ '.id': string; url: string; ssl_verify?: string; comment?: string; match_pattern?: string }>> {
    return this.req<Array<{ '.id': string; url: string; ssl_verify?: string; comment?: string; match_pattern?: string }>>('GET', '/ip/dns/adlist');
  }

  async addAdlist(url: string, comment: string): Promise<string> {
    // ssl-verify="no" is required for some lists hosted on raw.githubusercontent.com
    // — MikroTik's cert chain handling is conservative. Hagezi and StevenBlack lists
    // all served from GitHub raw which the router can fetch fine with verification off.
    const created = await this.req<{ '.id': string }>('PUT', '/ip/dns/adlist', {
      url,
      comment,
      'ssl-verify': 'no',
    });
    return created['.id'];
  }

  async removeAdlist(id: string): Promise<void> {
    try { await this.req('DELETE', `/ip/dns/adlist/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return;
      throw e;
    }
  }

  /** Trigger MikroTik to re-fetch all adlist subscriptions immediately. */
  async refreshAdlists(): Promise<void> {
    try { await this.req('POST', '/ip/dns/adlist/update', {}); } catch { /* router doesn't always expose this */ }
  }

  /**
   * Add a forward-chain drop rule scoped to a MAC and a time window.
   * Uses RouterOS's built-in `time` matcher so the router enforces the
   * schedule natively — no /system/scheduler involvement (which is gated
   * by device-mode in 7.x and requires physical confirmation to unlock).
   */
  async addScheduledMacBlock(mac: string, timeMatcher: string, comment: string): Promise<string> {
    const created = await this.req<MtFirewallRule>('PUT', '/ip/firewall/filter', {
      chain: 'forward',
      'src-mac-address': mac,
      action: 'drop',
      time: timeMatcher,
      comment,
    });
    if (created['.id']) {
      try { await this.req('POST', '/ip/firewall/filter/move', { numbers: created['.id'], destination: '0' }); }
      catch { /* not fatal — drop rule still works wherever it lands */ }
    }
    return created['.id'];
  }

  /** Toggle the `disabled` attribute on a firewall filter rule. */
  async setRuleDisabled(id: string, disabled: boolean): Promise<void> {
    await this.req('PATCH', `/ip/firewall/filter/${id}`, { disabled: disabled ? 'true' : 'false' });
  }

  /** Look up a single filter rule (used by gateway to gate gombwe-only mgmt). */
  async getFilterRule(id: string): Promise<MtFirewallRule | null> {
    try { return await this.req<MtFirewallRule>('GET', `/ip/firewall/filter/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null;
      throw e;
    }
  }

  /** Remove a firewall filter rule by .id. Idempotent — missing rule is treated as success. */
  async removeRule(id: string): Promise<void> {
    try { await this.req('DELETE', `/ip/firewall/filter/${id}`); }
    catch (e) {
      if (e instanceof Error && e.message.includes('404')) return;
      throw e;
    }
  }

  /**
   * Sever every active conntrack flow whose source IP matches. Adding a
   * firewall drop rule only stops NEW packets; existing TCP sessions live
   * on until they idle out. To preempt mid-stream (kid is watching → block
   * fires → video freezes), we also remove the matching conntrack entries.
   * Returns the number of flows killed.
   */
  async killConnectionsFromIp(srcIp: string): Promise<number> {
    const all = await this.connections();
    const matches = all.filter(c => {
      const ip = c['src-address']?.split(':')[0];
      return ip === srcIp;
    });
    // Delete in parallel — each is independent. Tolerate 404 (already gone).
    let killed = 0;
    await Promise.all(matches.map(async c => {
      try {
        await this.req('DELETE', `/ip/firewall/connection/${c['.id']}`);
        killed++;
      } catch { /* one stale conn is not worth aborting */ }
    }));
    return killed;
  }

  /**
   * Sever only conntrack flows from srcIp → dstIp. Targeted variant for
   * category enforcement — killing every connection from the kid's device
   * would also drop their unrelated apps (Spotify, school iMessage, etc.),
   * which is collateral the parental-control UX shouldn't inflict.
   */
  async killConnectionsBetween(srcIp: string, dstIp: string): Promise<number> {
    const all = await this.connections();
    const matches = all.filter(c => {
      const s = c['src-address']?.split(':')[0];
      const d = c['dst-address']?.split(':')[0];
      return s === srcIp && d === dstIp;
    });
    let killed = 0;
    await Promise.all(matches.map(async c => {
      try { await this.req('DELETE', `/ip/firewall/connection/${c['.id']}`); killed++; } catch { /* tolerate */ }
    }));
    return killed;
  }

  /** Add a firewall drop rule for a specific destination IP from a specific source MAC. */
  async addDstBlockForMac(mac: string, dstIp: string, comment: string): Promise<string> {
    const created = await this.req<MtFirewallRule>('PUT', '/ip/firewall/filter', {
      chain: 'forward',
      'src-mac-address': mac,
      'dst-address': dstIp,
      action: 'drop',
      comment,
    });
    if (created['.id']) {
      try { await this.req('POST', '/ip/firewall/filter/move', { numbers: created['.id'], destination: '0' }); }
      catch { /* ordering best-effort */ }
    }
    return created['.id'];
  }
}

/** Process-wide singleton — gateway and services share the same client. */
export const mikrotik = new MikroTikClient();
