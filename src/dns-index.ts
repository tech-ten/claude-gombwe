/**
 * DNS answer index — a persistent reverse map of resolved-IP -> hostname,
 * built by polling the MikroTik DNS cache (/ip/dns/cache) every snapshot tick.
 *
 * The DNS *query* log records hostname + client but not the answer IP, and
 * NetFlow records IPs but not names. This index bridges them so the usage
 * dossier can label a flow's destination IP with the hostname that resolved to
 * it ("youtube" instead of 142.250.x). Best-effort: CDN IPs serve many names,
 * so we keep the most-recently-seen name per IP.
 *
 * Stored at ~/.claude-gombwe/data/network/dns-index.json. Entries older than
 * RETENTION_DAYS are pruned (matches the flow-record retention).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const INDEX_PATH = join(DATA_DIR, 'dns-index.json');
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface Entry { name: string; lastSeen: number; }

class DnsIndex {
  private map: Map<string, Entry> | null = null;
  private dirty = false;

  private load(): Map<string, Entry> {
    if (this.map) return this.map;
    this.map = new Map();
    try {
      const obj = JSON.parse(readFileSync(INDEX_PATH, 'utf-8')) as Record<string, Entry>;
      for (const [ip, e] of Object.entries(obj)) {
        if (e && e.name && Date.now() - e.lastSeen < RETENTION_MS) this.map.set(ip, e);
      }
    } catch { /* no index yet */ }
    return this.map;
  }

  /** Merge MikroTik DNS cache rows (A/AAAA) into the reverse index. */
  merge(rows: Array<{ name?: string; type?: string; address?: string; data?: string }>): void {
    const map = this.load();
    const now = Date.now();
    for (const r of rows) {
      if (r.type !== 'A' && r.type !== 'AAAA') continue;
      const ip = r.address || r.data;
      const name = r.name;
      if (!ip || !name || name === 'router.lan') continue;
      map.set(ip, { name, lastSeen: now });
      this.dirty = true;
    }
    if (this.dirty) this.persist();
  }

  /** hostname most recently resolved to this IP, or null. */
  lookup(ip: string): string | null {
    return this.load().get(ip)?.name ?? null;
  }

  private persist(): void {
    const map = this.load();
    // prune stale on the way out
    for (const [ip, e] of map) if (Date.now() - e.lastSeen >= RETENTION_MS) map.delete(ip);
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const obj: Record<string, Entry> = {};
      for (const [ip, e] of map) obj[ip] = e;
      writeFileSync(INDEX_PATH, JSON.stringify(obj), { mode: 0o600 });
      this.dirty = false;
    } catch { /* disk issue — keep in memory */ }
  }
}

let _instance: DnsIndex | null = null;
export function dnsIndex(): DnsIndex {
  if (!_instance) _instance = new DnsIndex();
  return _instance;
}
