/**
 * Router target self-healer.
 *
 * The MikroTik pushes two feeds to gombwe by IP address, both configured once
 * and then forgotten by RouterOS:
 *   - the `remote` logging action (DNS query stream, udp/1514)
 *   - the /ip/traffic-flow target (NetFlow v9 session records, udp/2055)
 *
 * gombwe's host gets its address from DHCP over Wi-Fi, and macOS rotates the
 * private Wi-Fi MAC, so the address drifts. When it does, the router keeps
 * shipping both feeds to the OLD address: DNS detection goes blind, and the
 * usage dossier silently falls back to estimates. Both have happened. The DNS
 * feed got a healer after a 7-day blackout; NetFlow never did and was blind for
 * three months before anyone noticed.
 *
 * This module compares every router target to this host's current LAN IP on
 * a timer and repoints whatever is stale. It only writes when something is wrong.
 *
 * Ownership: exactly ONE gombwe instance may steer the router. A dev instance on
 * a laptop running the same code would otherwise fight the daemon, flipping the
 * targets back and forth every tick (observed: 256 flips). Only the headless
 * daemon is the owner; every other instance leaves the router alone.
 */
import { networkInterfaces } from 'node:os';

export interface RouterClient {
  raw<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

const DNS_LOG_PORT = '1514';
const LAN_PREFIX = '192.168.88.';        // same LAN the router + receivers live on
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 minutes

interface LoggingAction { '.id': string; name?: string; remote?: string; 'remote-port'?: string }
interface LoggingRule { '.id': string; topics?: string; action?: string; disabled?: string }
interface TrafficFlowTarget { '.id': string; 'dst-address'?: string; port?: string; disabled?: string }

let timer: NodeJS.Timeout | null = null;

/** This host's current LAN IPv4 on the monitored subnet (the address the router should target). */
export function currentLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && i.address.startsWith(LAN_PREFIX)) return i.address;
    }
  }
  return null;
}

/** Keep the router's `remote` logging action (DNS feed) pointed at myIp. */
async function ensureDnsLogTarget(client: RouterClient, myIp: string): Promise<string> {
  const actions = await client.raw<LoggingAction[]>('GET', '/system/logging/action');
  const remote = actions.find(a => a.name === 'remote');
  if (!remote) return 'skipped: dns-log — no `remote` logging action on router';

  if (remote.remote === myIp && remote['remote-port'] === DNS_LOG_PORT) {
    return `ok: dns-log target already ${myIp}:${DNS_LOG_PORT}`;
  }

  await client.raw('PATCH', `/system/logging/action/${remote['.id']}`, { remote: myIp, 'remote-port': DNS_LOG_PORT });

  // RouterOS caches the resolved target; toggle each `dns -> remote` rule so it re-inits.
  const rules = await client.raw<LoggingRule[]>('GET', '/system/logging');
  const dnsRemoteRules = rules.filter(r => (r.topics || '').includes('dns') && r.action === 'remote');
  for (const r of dnsRemoteRules) {
    await client.raw('PATCH', `/system/logging/${r['.id']}`, { disabled: 'yes' });
    await client.raw('PATCH', `/system/logging/${r['.id']}`, { disabled: 'no' });
  }
  return `repointed dns-log ${remote.remote ?? '(unset)'} -> ${myIp}:${DNS_LOG_PORT} (re-initialised ${dnsRemoteRules.length} rule(s))`;
}

/** Keep every /ip/traffic-flow target (NetFlow feed) pointed at myIp. */
async function ensureNetflowTarget(client: RouterClient, myIp: string): Promise<string> {
  const targets = await client.raw<TrafficFlowTarget[]>('GET', '/ip/traffic-flow/target');
  if (targets.length === 0) return 'skipped: netflow — no traffic-flow target on router';

  const stale = targets.filter(t => t['dst-address'] !== myIp);
  if (stale.length === 0) return `ok: netflow target already ${myIp}`;

  for (const t of stale) {
    await client.raw('PATCH', `/ip/traffic-flow/target/${t['.id']}`, { 'dst-address': myIp });
  }
  return `repointed netflow ${stale.map(t => t['dst-address'] ?? '(unset)').join(',')} -> ${myIp}`;
}

/**
 * Check every router target against myIp and repoint what is stale.
 * Returns one status line per target. Each target is checked independently so
 * a failure on one never blocks the other.
 */
export async function ensureRouterTargets(client: RouterClient, myIp: string): Promise<string[]> {
  const results = await Promise.allSettled([
    ensureDnsLogTarget(client, myIp),
    ensureNetflowTarget(client, myIp),
  ]);
  return results.map(r => r.status === 'fulfilled' ? r.value : `failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
}

export interface HealerOptions {
  /** True only for the instance allowed to write to the router (the headless daemon). */
  owner: boolean;
  client?: RouterClient;
  myIp?: () => string | null;
}

/** Run the check once now, then every 5 minutes. Idempotent — safe to call once at startup. */
export function startRouterTargetHealer(opts: HealerOptions): void {
  if (timer) return;
  if (!opts.owner) {
    console.log('[router-healer] not the router owner (non-headless instance) — router targets left untouched');
    return;
  }
  const getIp = opts.myIp ?? currentLanIp;
  const tick = async () => {
    try {
      const client = opts.client ?? (await import('./mikrotik-client.js')).mikrotik;
      const myIp = getIp();
      if (!myIp) { console.log('[router-healer] skipped: no LAN IP on this host'); return; }
      for (const status of await ensureRouterTargets(client, myIp)) {
        if (!status.startsWith('ok')) console.log(`[router-healer] ${status}`);
      }
    } catch (err) {
      console.warn(`[router-healer] check failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  void tick();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  console.log(`[router-healer] watching router dns-log + netflow targets every ${CHECK_INTERVAL_MS / 60_000}m`);
}

export function stopRouterTargetHealer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
