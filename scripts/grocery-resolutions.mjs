/**
 * GROCERY RESOLUTIONS — cache of (watchlist item → store → resolved product).
 *
 * Once Haiku has picked the canonical Coles/Woolies product for a
 * watchlist item, that picking is a stable mapping. Subsequent runs
 * just need to find the same product by stable ID (Coles URL ID,
 * Woolies stockcode) and read its current price/cup. No LLM needed.
 *
 * We only re-invoke Haiku when:
 *   - the previously-picked product is no longer in search results
 *     (delisted, out of stock, search noise)
 *   - the user passes --force-reclassify (e.g. iterating on prompt or
 *     watchlist semantics)
 *   - no resolution exists yet for that item+store
 *
 * Cache schema (~/.claude-gombwe/data/grocery-resolutions.json):
 *   {
 *     updated_at: ISO,
 *     resolutions: {
 *       "Salted Butter 500g": {
 *         coles:   { product_id, product_url, product_name, resolved_at, last_seen_at, classifier_source },
 *         woolies: { ... }
 *       },
 *       ...
 *     }
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { classifyMatch } from './grocery-classifier.mjs';

const RESOLUTIONS_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-resolutions.json');

export function loadResolutions() {
  if (!existsSync(RESOLUTIONS_FILE)) return { updated_at: null, resolutions: {} };
  try {
    const parsed = JSON.parse(readFileSync(RESOLUTIONS_FILE, 'utf8'));
    if (!parsed.resolutions) parsed.resolutions = {};
    return parsed;
  } catch {
    return { updated_at: null, resolutions: {} };
  }
}

export function saveResolutions(data) {
  data.updated_at = new Date().toISOString();
  mkdirSync(dirname(RESOLUTIONS_FILE), { recursive: true });
  writeFileSync(RESOLUTIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Stable product identifier from a scraper candidate. Both scraper
 *  paths now set `product_id` as an explicit first-class field; this
 *  helper keeps a URL-parse fallback for older records or any future
 *  caller that constructs candidates without going through grocery-lib. */
export function productKey(candidate, store) {
  if (!candidate) return null;
  if (candidate.product_id) return String(candidate.product_id);
  const s = store.toLowerCase();
  if (s === 'woolworths' || s === 'woolies') {
    return candidate.stockcode != null ? String(candidate.stockcode) : null;
  }
  if (s === 'coles') {
    const m = candidate.url?.match(/-(\d{4,})(?:[/?#].*)?$/);
    return m ? m[1] : (candidate.url || null);
  }
  return candidate.url || null;
}

/**
 * Get the best match for an item from a candidate list, using cached
 * resolution when possible. Falls through to the Haiku classifier on
 * cache miss or when the cached product is no longer in candidates.
 *
 * Returns { picked, source, fromCache, ... }
 *   source: 'cached' | 'haiku' | 'only-candidate' | 'empty-shortlist' | 'fallback-*'
 *   fromCache: true when we returned a cached resolution without calling Haiku
 */
/**
 * Resolve best match for an item from a candidate list.
 *
 * `cache` (optional): a pre-loaded resolutions object (from
 * loadResolutions()) that the caller is responsible for persisting via
 * saveResolutions() once batch work is done. Threading the cache lets
 * concurrent callers (e.g. parallel store probes) share state without
 * racing on file I/O. When not provided, falls back to per-call load +
 * save (safe for single-shot use).
 */
export async function resolveBestMatch(item, candidates, store, opts = {}) {
  const { forceReclassify = false, cache } = opts;
  const data = cache ?? loadResolutions();
  const ownsCache = cache == null;
  const cacheKey = item.name;
  const cached = data.resolutions[cacheKey]?.[store];

  if (!forceReclassify && cached?.product_id && candidates?.length) {
    const stillThere = candidates.find(c => productKey(c, store) === cached.product_id);
    if (stillThere) {
      cached.last_seen_at = new Date().toISOString();
      // Refresh the snapshot name if Coles tweaked the title — keeps
      // the cache honest without invalidating the binding.
      if (stillThere.name && stillThere.name !== cached.product_name) {
        cached.product_name = stillThere.name;
      }
      if (ownsCache) saveResolutions(data);
      return { picked: stillThere, source: 'cached', fromCache: true };
    }
    // Cached product not in current candidates — re-classify.
  }

  // Cache miss (or forced refresh) — invoke Haiku.
  const result = await classifyMatch(item, candidates, store);
  result.fromCache = false;

  if (result.picked) {
    const pid = productKey(result.picked, store);
    if (!data.resolutions[cacheKey]) data.resolutions[cacheKey] = {};
    const now = new Date().toISOString();
    data.resolutions[cacheKey][store] = {
      product_id: pid,
      product_url: result.picked.url || null,
      product_name: result.picked.name,
      resolved_at: now,
      last_seen_at: now,
      classifier_source: result.source,
      ...(result.raw ? { haiku_raw: result.raw } : {}),
    };
    if (ownsCache) saveResolutions(data);
  }
  return result;
}

/** Direct read for diagnostics / external scripts. */
export function getCachedResolution(itemName, store) {
  const data = loadResolutions();
  return data.resolutions[itemName]?.[store] || null;
}
