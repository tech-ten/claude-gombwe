/**
 * IP → readable name resolver.
 *
 * Two layers:
 *   1. Static heuristic (known cloud/CDN IP ranges → "Apple", "Google", "Meta", etc.)
 *      Applies instantly, no IO.
 *   2. Reverse DNS (PTR lookup) for everything else. Asynchronous; results
 *      are cached on disk so the next request is instant.
 *
 * Callers stay synchronous — `resolveSync(ip)` returns the best name available
 * right now, and kicks off a reverse lookup in the background if there's no
 * hit yet. Subsequent calls return the cached result.
 */
import { promises as dns } from 'node:dns';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_PATH = join(homedir(), '.claude-gombwe', 'network-ip-cache.json');

// ── Heuristic: known IP ranges → friendly owner ──────────────────────────
// CIDRs are compared by checking that the candidate IP falls inside the range.
// We only encode well-known consumer/CDN ranges; specific sub-services (youtube
// vs maps) are left to reverse DNS, which usually surfaces them.
//
// References: ARIN/RIPE allocations, Apple's NSPid 17.0.0.0/8, etc.
const KNOWN_RANGES: Array<{ cidr: string; name: string }> = [
  // Apple
  { cidr: '17.0.0.0/8',      name: 'Apple' },

  // Google / YouTube / Gmail / Maps (largest blocks)
  { cidr: '8.8.8.0/24',      name: 'Google DNS' },
  { cidr: '8.8.4.0/24',      name: 'Google DNS' },
  { cidr: '142.250.0.0/15',  name: 'Google' },
  { cidr: '142.251.0.0/16',  name: 'Google' },
  { cidr: '172.217.0.0/16',  name: 'Google' },
  { cidr: '216.58.192.0/19', name: 'Google' },
  { cidr: '209.85.128.0/17', name: 'Google' },
  { cidr: '74.125.0.0/16',   name: 'Google' },
  { cidr: '64.233.160.0/19', name: 'Google' },
  { cidr: '192.178.0.0/15',  name: 'Google' },
  { cidr: '34.0.0.0/8',      name: 'Google Cloud' },  // overlaps with AWS — Google moved here
  { cidr: '35.184.0.0/13',   name: 'Google Cloud' },

  // Meta / Facebook / Instagram / WhatsApp
  { cidr: '31.13.24.0/21',   name: 'Meta' },
  { cidr: '31.13.64.0/18',   name: 'Meta' },
  { cidr: '66.220.144.0/20', name: 'Meta' },
  { cidr: '69.171.224.0/19', name: 'Meta' },
  { cidr: '157.240.0.0/16',  name: 'Meta' },
  { cidr: '173.252.64.0/19', name: 'Meta' },
  { cidr: '163.70.128.0/17', name: 'Meta' },
  { cidr: '199.201.64.0/22', name: 'Meta' },

  // Microsoft / Azure / Bing / Office
  { cidr: '13.64.0.0/11',    name: 'Microsoft Azure' },
  { cidr: '20.0.0.0/8',      name: 'Microsoft Azure' },
  { cidr: '40.74.0.0/15',    name: 'Microsoft Azure' },
  { cidr: '52.96.0.0/12',    name: 'Microsoft Azure' },
  { cidr: '104.40.0.0/13',   name: 'Microsoft Azure' },

  // AWS (the big chunks; not exhaustive)
  { cidr: '3.0.0.0/8',       name: 'AWS' },
  { cidr: '52.0.0.0/8',      name: 'AWS' },  // covers many AWS ranges
  { cidr: '54.0.0.0/8',      name: 'AWS' },
  { cidr: '18.0.0.0/8',      name: 'AWS' },

  // Cloudflare
  { cidr: '1.1.1.0/24',      name: 'Cloudflare DNS' },
  { cidr: '1.0.0.0/24',      name: 'Cloudflare DNS' },
  { cidr: '104.16.0.0/12',   name: 'Cloudflare' },
  { cidr: '172.64.0.0/13',   name: 'Cloudflare' },
  { cidr: '162.158.0.0/15',  name: 'Cloudflare' },
  { cidr: '188.114.96.0/20', name: 'Cloudflare' },

  // Akamai (used by many e.g. Netflix, Spotify, Apple updates)
  { cidr: '23.32.0.0/11',    name: 'Akamai' },
  { cidr: '23.192.0.0/11',   name: 'Akamai' },
  { cidr: '104.64.0.0/10',   name: 'Akamai' },
  { cidr: '184.24.0.0/13',   name: 'Akamai' },

  // Fastly (many news sites, Shopify, etc.)
  { cidr: '151.101.0.0/16',  name: 'Fastly' },
  { cidr: '199.232.0.0/16',  name: 'Fastly' },
  { cidr: '146.75.0.0/16',   name: 'Fastly' },

  // Netflix
  { cidr: '45.57.0.0/17',    name: 'Netflix' },
  { cidr: '108.175.32.0/20', name: 'Netflix' },

  // TikTok / ByteDance
  { cidr: '161.117.0.0/16',  name: 'TikTok / ByteDance' },
  { cidr: '163.70.128.0/17', name: 'TikTok / ByteDance' },

  // Discord (cloud-hosted on Cloudflare mostly; explicit ranges scarce)

  // Local / private
  { cidr: '192.168.0.0/16',  name: 'local network' },
  { cidr: '10.0.0.0/8',      name: 'local network' },
  { cidr: '172.16.0.0/12',   name: 'local network' },
  { cidr: '224.0.0.0/4',     name: 'multicast' },
  { cidr: '255.255.255.255/32', name: 'broadcast' },
];

function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return -1;
  // (Use multiplication, not <<24, because JavaScript bitwise treats operands as 32-bit signed.)
  return p[0] * 0x1000000 + (p[1] << 16) + (p[2] << 8) + p[3];
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipInt = ipToInt(ip);
  const netInt = ipToInt(net);
  if (ipInt < 0 || netInt < 0 || Number.isNaN(bits)) return false;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((netInt & mask) >>> 0);
}

function heuristicName(ip: string): string | null {
  for (const r of KNOWN_RANGES) {
    if (cidrMatch(ip, r.cidr)) return r.name;
  }
  return null;
}

interface CacheEntry {
  name: string | null;       // null = lookup yielded nothing useful
  resolved_at: string;
}

class IpNameResolver {
  private cache: Map<string, CacheEntry> = new Map();
  private inflight: Set<string> = new Set();
  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(CACHE_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as Record<string, CacheEntry>;
      for (const [ip, entry] of Object.entries(raw)) this.cache.set(ip, entry);
    } catch { /* ignore corrupt cache */ }
  }

  private flush(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (!this.dirty) return;
      try {
        const obj: Record<string, CacheEntry> = {};
        for (const [ip, entry] of this.cache) obj[ip] = entry;
        writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
        this.dirty = false;
      } catch (err) { console.warn('[ip-resolver] cache write failed:', err); }
    }, 2_000);
  }

  /**
   * Synchronous resolve: returns the best name we have right now.
   * Triggers a background reverse-DNS lookup if we haven't seen this IP before.
   */
  resolveSync(ip: string): string {
    // Heuristic always wins — it's authoritative for known ranges, and faster than DNS.
    const h = heuristicName(ip);
    if (h) return h;

    const cached = this.cache.get(ip);
    if (cached) return cached.name ?? ip;

    // Kick off a non-blocking lookup. The first call after each restart will
    // see the IP, then on the *next* request the cache hits.
    if (!this.inflight.has(ip)) this.lookup(ip);
    return ip;
  }

  private async lookup(ip: string): Promise<void> {
    this.inflight.add(ip);
    try {
      const names = await Promise.race([
        dns.reverse(ip),
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      // Pick the shortest result — usually the cleanest canonical hostname.
      const cleanest = names.sort((a, b) => a.length - b.length)[0] ?? null;
      this.cache.set(ip, { name: cleanest, resolved_at: new Date().toISOString() });
    } catch {
      // Cache the negative result so we don't keep retrying.
      this.cache.set(ip, { name: null, resolved_at: new Date().toISOString() });
    } finally {
      this.inflight.delete(ip);
      this.dirty = true;
      this.flush();
    }
  }
}

let _instance: IpNameResolver | null = null;
export function ipResolver(): IpNameResolver {
  if (!_instance) _instance = new IpNameResolver();
  return _instance;
}
