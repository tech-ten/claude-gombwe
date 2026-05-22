/**
 * Real-time per-device category enforcement.
 *
 * Subscribes to the DNS log stream. For each query:
 *   1. Map client IP → MAC via a refreshed lease cache.
 *   2. Look up the device's category policy.
 *   3. If the hostname falls into a blocked category for this MAC, call
 *      NetworkService.enforceCategoryBlock — adds a per-MAC dst-IP drop
 *      rule and kills any active conntrack flows from that device.
 *   4. Audit-log the attempt (handled inside enforceCategoryBlock).
 *
 * Throttling: same (mac, hostname) pair within ATTEMPT_DEDUP_WINDOW_MS is
 * skipped — we already added a rule and don't need 100 audit entries when
 * the device retries every 200ms during the conntrack-kill grace period.
 *
 * Limitation: when a category is removed from a device's policy, the
 * already-added firewall rules persist until the device is manually
 * unblocked. A follow-up will prune by walking gombwe-cat-commented rules.
 */

import { dnsReceiver, type DnsQueryRecord } from './dns-log-receiver.js';
import { getNetworkService } from './network-service.js';
import { categoryFor } from './blocklist-cache.js';
import { mikrotik } from './mikrotik-client.js';

const LEASE_REFRESH_MS = 30_000;
const ATTEMPT_DEDUP_WINDOW_MS = 60_000;

const ipToMac = new Map<string, string>();
let lastLeaseRefresh = 0;
let leaseRefreshInFlight: Promise<void> | null = null;

const recentAttempts = new Map<string, number>(); // `${mac}::${hostname}` → ms

let started = false;

export function startCategoryEnforcer(): void {
  if (started) return;
  started = true;
  dnsReceiver().on('query', (rec: DnsQueryRecord) => {
    handle(rec).catch(err => console.warn('[category-enforcer] handler error:', err?.message ?? err));
  });
  console.log('[category-enforcer] started — listening on DNS log');
}

async function refreshLeases(): Promise<void> {
  if (Date.now() - lastLeaseRefresh < LEASE_REFRESH_MS) return;
  if (leaseRefreshInFlight) return leaseRefreshInFlight;
  leaseRefreshInFlight = (async () => {
    try {
      const leases = await mikrotik.dhcpLeases();
      ipToMac.clear();
      for (const l of leases) {
        if (l.address && l['mac-address']) {
          ipToMac.set(l.address, l['mac-address'].toUpperCase());
        }
      }
      lastLeaseRefresh = Date.now();
    } catch (err) {
      console.warn('[category-enforcer] lease refresh failed:', (err as Error).message);
    } finally {
      leaseRefreshInFlight = null;
    }
  })();
  return leaseRefreshInFlight;
}

async function handle(rec: DnsQueryRecord): Promise<void> {
  if (!rec.client_ip || !rec.hostname) return;

  await refreshLeases();
  const mac = ipToMac.get(rec.client_ip);
  if (!mac) return;

  const svc = getNetworkService();
  const policy = svc.getDevicePolicy(mac);
  if (policy.blockedCategories.length === 0) return;

  const category = categoryFor(rec.hostname);
  if (!category || !policy.blockedCategories.includes(category)) return;

  // Dedupe — same (mac, hostname) within the window already triggered an
  // action; subsequent attempts are noise (the device is retrying because
  // we just severed conntrack).
  const dkey = `${mac}::${rec.hostname}`;
  const last = recentAttempts.get(dkey) ?? 0;
  if (Date.now() - last < ATTEMPT_DEDUP_WINDOW_MS) return;
  recentAttempts.set(dkey, Date.now());

  const result = await svc.enforceCategoryBlock(mac, rec.hostname, category, rec.answer);
  console.log(
    `[category-enforcer] mac=${mac} host=${rec.hostname} category=${category} ips=${result.ips.length} rules=${result.rule_ids.length} killed=${result.killed}`,
  );
}
