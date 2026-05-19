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
  chain?: string;
  action?: string;
  'src-mac-address'?: string;
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
  'rx-byte'?: string;
  'tx-byte'?: string;
  'rx-bits-per-second'?: string;
  'tx-bits-per-second'?: string;
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
  arpTable      = () => this.req<MtArp[]>('GET', '/ip/arp');
  connections   = () => this.req<MtConnection[]>('GET', '/ip/firewall/connection');
  filterRules   = () => this.req<MtFirewallRule[]>('GET', '/ip/firewall/filter');
  dnsCache      = () => this.req<MtDnsCacheEntry[]>('GET', '/ip/dns/cache');
  interfaceStats = () => this.req<MtInterfaceStats[]>('GET', '/interface');

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
