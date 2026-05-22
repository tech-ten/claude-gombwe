/**
 * Local blocklist cache — fetch and parse the curated AdBlock-format lists,
 * keep them in memory + on disk, expose categoryFor(hostname) lookup.
 *
 * Why we need this even though the router has its own copy: 5b.2 wants to
 * decide "is this domain blocked for this kid?" on every DNS query, in
 * real time. The router won't tell us "yes that's in Hagezi Adult" — it
 * just returns NXDOMAIN to everyone. So gombwe needs its own classifier.
 *
 * Storage: ~/.claude-gombwe/data/network/blocklist-cache.json
 *   Persisted across restarts so we don't re-fetch 800k entries every reboot.
 *   Daily background refresh keeps it fresh; manual /refresh endpoint exists.
 *
 * Category priority (highest first): dangerous > adult > gambling > ads > social.
 * If a domain appears in multiple lists from different categories, the
 * highest-priority category wins for classification — relevant for the
 * chart and for per-device enforcement decisions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BLOCKLIST_SOURCES } from './blocklist-sources.js';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const CACHE_FILE = join(DATA_DIR, 'blocklist-cache.json');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
const CATEGORY_PRIORITY = ['dangerous', 'adult', 'gambling', 'ads', 'social'];

interface SourceMeta { fetchedAt: string; entryCount: number; error?: string }

interface PersistedState {
  sources: Record<string, SourceMeta>;
  categories: Record<string, string[]>;
}

interface InMemoryState {
  byCategory: Map<string, Set<string>>;
  hostnameToCategory: Map<string, string>;
  sources: Record<string, SourceMeta>;
}

let state: InMemoryState | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** Parse an AdBlock-format file. Lines look like `||domain.com^`. */
function parseAdBlock(text: string): string[] {
  const out: string[] = [];
  const re = /^\|\|([^\s\^]+)\^/;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '!' || trimmed[0] === '[') continue;
    const m = re.exec(trimmed);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

async function fetchSource(url: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parseAdBlock(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rebuild the in-memory hostname→category index from per-category sets.
 * Iterates categories in priority order so a hostname in both Adult and Ads
 * is classified as Adult.
 */
function rebuildIndex(byCategory: Map<string, Set<string>>): Map<string, string> {
  const index = new Map<string, string>();
  // Walk in REVERSE priority — lowest first — so highest overwrites.
  const reversed = [...CATEGORY_PRIORITY].reverse();
  for (const cat of reversed) {
    const set = byCategory.get(cat);
    if (!set) continue;
    for (const d of set) index.set(d, cat);
  }
  // Any categories outside the priority list get appended last (so they
  // can be overwritten by priority ones if they were missed above).
  for (const [cat, set] of byCategory) {
    if (CATEGORY_PRIORITY.includes(cat)) continue;
    for (const d of set) if (!index.has(d)) index.set(d, cat);
  }
  return index;
}

export function loadFromDisk(): boolean {
  if (!existsSync(CACHE_FILE)) return false;
  try {
    const parsed: PersistedState = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    const byCategory = new Map<string, Set<string>>();
    for (const [cat, domains] of Object.entries(parsed.categories || {})) {
      byCategory.set(cat, new Set(domains));
    }
    state = {
      byCategory,
      hostnameToCategory: rebuildIndex(byCategory),
      sources: parsed.sources || {},
    };
    return true;
  } catch (e) {
    console.warn('[blocklist-cache] disk load failed:', (e as Error).message);
    return false;
  }
}

export async function refresh(): Promise<{ refreshed: number; failed: number; totalEntries: number }> {
  ensureDir();
  const sources: Record<string, SourceMeta> = {};
  const byCategory = new Map<string, Set<string>>();

  const results = await Promise.allSettled(
    BLOCKLIST_SOURCES.map(async (src) => ({ src, entries: await fetchSource(src.url) }))
  );

  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const src = BLOCKLIST_SOURCES[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      sources[src.id] = { fetchedAt: new Date().toISOString(), entryCount: r.value.entries.length };
      const set = byCategory.get(src.category) ?? new Set<string>();
      for (const e of r.value.entries) set.add(e);
      byCategory.set(src.category, set);
    } else {
      failed++;
      sources[src.id] = {
        fetchedAt: new Date().toISOString(),
        entryCount: 0,
        error: (r.reason instanceof Error) ? r.reason.message : String(r.reason),
      };
    }
  }

  const persisted: PersistedState = {
    sources,
    categories: Object.fromEntries(
      Array.from(byCategory.entries()).map(([cat, set]) => [cat, Array.from(set).sort()])
    ),
  };
  writeFileSync(CACHE_FILE, JSON.stringify(persisted));

  state = { byCategory, hostnameToCategory: rebuildIndex(byCategory), sources };
  let total = 0;
  for (const s of byCategory.values()) total += s.size;
  return { refreshed: results.length - failed, failed, totalEntries: total };
}

/**
 * Find the category for a hostname by walking up parent domains.
 * `ads.cdn.bet365.com` tries `ads.cdn.bet365.com`, `cdn.bet365.com`, `bet365.com`.
 */
export function categoryFor(hostname: string): string | null {
  if (!state) return null;
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const cat = state.hostnameToCategory.get(candidate);
    if (cat) return cat;
  }
  return null;
}

export function status() {
  if (!state) return { loaded: false as const };
  const perCategory: Record<string, number> = {};
  let totalEntries = 0;
  for (const [cat, set] of state.byCategory) { perCategory[cat] = set.size; totalEntries += set.size; }
  return { loaded: true as const, perCategory, totalEntries, sources: state.sources };
}

function isStale(): boolean {
  if (!state) return true;
  const ts = Object.values(state.sources).map(s => Date.parse(s.fetchedAt) || 0);
  if (ts.length === 0) return true;
  return Date.now() - Math.min(...ts) > REFRESH_INTERVAL_MS;
}

/** Call once at server start. Non-blocking; fetch happens in the background. */
export function bootstrap(): void {
  loadFromDisk();
  if (isStale()) {
    refresh().catch(err => console.warn('[blocklist-cache] initial refresh failed:', err.message));
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refresh().catch(err => console.warn('[blocklist-cache] scheduled refresh failed:', err.message));
    }, REFRESH_INTERVAL_MS);
  }
}
