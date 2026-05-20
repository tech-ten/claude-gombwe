/**
 * Snapshot collector — periodic write of MikroTik state to ~/.claude-gombwe/data/network/.
 *
 * Replaces the standalone scripts/network-monitor.py so the whole capture
 * pipeline lives inside gombwe's process. Single thing to start, single thing
 * to restart, one Node process to monitor.
 *
 * Polls every POLL_MS (60s) and writes one JSONL line per poll:
 *   { ts, devices: [...], arp: [...], connections: [...] }
 *
 * Critical: NEVER throws out of tick(). A single transient MikroTik hiccup
 * must not stop the loop. The old Python collector died at 00:28 once because
 * a single http.client.IncompleteRead slipped past its narrow except clause —
 * losing 11+ hours of data. This implementation broad-catches.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mikrotik } from './mikrotik-client.js';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const POLL_MS = 60_000;

const LEASE_FIELDS = ['address','mac-address','host-name','status','comment','server'] as const;
const ARP_FIELDS   = ['address','mac-address','interface','complete'] as const;
const CONN_FIELDS  = [
  'src-address','dst-address','protocol',
  'orig-bytes','repl-bytes','orig-packets','repl-packets',
  'tcp-state','timeout','connection-mark',
] as const;

function pick<K extends string>(record: any, fields: readonly K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (record && record[f] !== undefined) out[f] = record[f];
  }
  return out;
}

function todayJsonlPath(): string {
  return join(DATA_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

let timer: NodeJS.Timeout | null = null;
let consecutiveErrors = 0;
let lastSuccessTs: string | null = null;

async function tick(): Promise<void> {
  try {
    const [leases, arp, conns] = await Promise.all([
      mikrotik.dhcpLeases(),
      mikrotik.arpTable(),
      mikrotik.connections(),
    ]);
    const ts = new Date().toISOString();
    const snap = {
      ts,
      devices: leases.map(l => pick(l, LEASE_FIELDS)),
      arp:     arp.map(a => pick(a, ARP_FIELDS)),
      connections: conns.map(c => pick(c, CONN_FIELDS)),
    };
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(todayJsonlPath(), JSON.stringify(snap) + '\n', { mode: 0o600 });

    const onlineCount = new Set(
      leases.filter(l => l.status === 'bound').map(l => l['mac-address']).filter(Boolean)
    ).size;
    if (consecutiveErrors > 0) {
      console.log(`[collector] recovered after ${consecutiveErrors} failure(s)`);
    }
    consecutiveErrors = 0;
    lastSuccessTs = ts;
    // Quiet on success — log only the first one and recoveries.
    if (!lastSuccessTs) console.log(`[collector] first snapshot ok devices=${onlineCount} connections=${conns.length}`);
  } catch (err: any) {
    consecutiveErrors++;
    const msg = err?.message ?? String(err);
    // Always log the first few failures, then quiet down to avoid spam.
    if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
      console.warn(`[collector] poll failed (${consecutiveErrors}x): ${msg}`);
    }
  }
}

export function startSnapshotCollector(): void {
  if (timer) return;
  console.log(`[collector] snapshot collector starting → ${DATA_DIR}/<date>.jsonl every ${POLL_MS / 1000}s`);
  // Fire first tick immediately so the JSONL gets the first datapoint right away.
  tick();
  timer = setInterval(tick, POLL_MS);
}

export function stopSnapshotCollector(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function snapshotCollectorStatus(): { running: boolean; consecutive_errors: number; last_success: string | null } {
  return {
    running: timer !== null,
    consecutive_errors: consecutiveErrors,
    last_success: lastSuccessTs,
  };
}
