/**
 * DNS feed self-healer.
 *
 * The MikroTik streams its `dns` topic logs to gombwe via a `remote` logging
 * action whose target is a hardcoded IP:port (gombwe's LAN address, udp/1514).
 * gombwe gets that address from DHCP, so if its IP drifts — e.g. macOS rotates
 * the Wi-Fi private MAC and the DHCP reservation stops matching — the router
 * keeps shipping logs to the OLD address. They vanish, the ring goes empty, and
 * the whole detection stack (flags, dossier, policy scanner) silently goes
 * blind. That exact failure cost a ~7-day blackout once already.
 *
 * This watchdog makes that impossible to persist: on a timer it compares the
 * router's `remote` action target to gombwe's own current LAN IP. On a mismatch
 * it repoints the action and toggles the `dns -> remote` rule (RouterOS caches
 * the resolved target and won't repoint until the rule re-inits). One restart
 * or one tick later, the feed is flowing again — no human, no SSH.
 */
import { networkInterfaces } from 'node:os';
import { mikrotik } from './mikrotik-client.js';

const DNS_LOG_PORT = '1514';
const LAN_PREFIX = '192.168.88.';        // same LAN the router + dns-receiver live on
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 minutes

interface LoggingAction { '.id': string; name?: string; remote?: string; 'remote-port'?: string }
interface LoggingRule { '.id': string; topics?: string; action?: string; disabled?: string }

let timer: NodeJS.Timeout | null = null;

/** gombwe's current LAN IPv4 on the monitored subnet (the address the router should target). */
export function currentLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && i.address.startsWith(LAN_PREFIX)) return i.address;
    }
  }
  return null;
}

/**
 * Ensure the router's `remote` logging action points at our current LAN IP.
 * Returns a short status string for logging. Safe to call repeatedly — it only
 * writes when the target is actually wrong.
 */
export async function ensureDnsLogTarget(): Promise<string> {
  const myIp = currentLanIp();
  if (!myIp) return 'skipped: no LAN IP on this host';

  const actions = await mikrotik.raw<LoggingAction[]>('GET', '/system/logging/action');
  const remote = actions.find(a => a.name === 'remote');
  if (!remote) return 'skipped: no `remote` logging action on router';

  if (remote.remote === myIp && remote['remote-port'] === DNS_LOG_PORT) {
    return `ok: target already ${myIp}:${DNS_LOG_PORT}`;
  }

  // Repoint the action…
  await mikrotik.raw('PATCH', `/system/logging/action/${remote['.id']}`, {
    remote: myIp, 'remote-port': DNS_LOG_PORT,
  });

  // …then toggle every `dns -> remote` rule so RouterOS re-resolves the target.
  const rules = await mikrotik.raw<LoggingRule[]>('GET', '/system/logging');
  const dnsRemoteRules = rules.filter(r => (r.topics || '').includes('dns') && r.action === 'remote');
  for (const r of dnsRemoteRules) {
    await mikrotik.raw('PATCH', `/system/logging/${r['.id']}`, { disabled: 'yes' });
    await mikrotik.raw('PATCH', `/system/logging/${r['.id']}`, { disabled: 'no' });
  }

  return `repointed ${remote.remote ?? '(unset)'} -> ${myIp}:${DNS_LOG_PORT} (re-initialised ${dnsRemoteRules.length} rule(s))`;
}

/** Run the check once now, then on a 5-minute timer. Idempotent — safe to call once at startup. */
export function startDnsFeedHealer(): void {
  if (timer) return;
  const tick = () => ensureDnsLogTarget()
    .then(status => { if (!status.startsWith('ok')) console.log(`[dns-healer] ${status}`); })
    .catch(err => console.warn(`[dns-healer] check failed: ${err instanceof Error ? err.message : err}`));
  tick();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  console.log(`[dns-healer] watching router DNS-log target every ${CHECK_INTERVAL_MS / 60_000}m`);
}

export function stopDnsFeedHealer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
