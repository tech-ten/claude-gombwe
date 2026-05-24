/**
 * GROCERY API ENDPOINT CACHE
 *
 * discoverColesApi() sniffs the page network for a search-API URL each
 * session — slow (~25s), noisy (registers a search), and detectable
 * (load + idle + scrape pattern). Cache successful patterns so we can
 * try them directly on subsequent runs.
 *
 * Quick validation: hit the cached endpoint with a low-cardinality
 * dummy query, confirm it returns a reasonable response shape, use it.
 * Only fall back to network-sniffing on full validation miss.
 *
 * Cache schema (~/.claude-gombwe/data/grocery-coles-api.json):
 *   {
 *     updated_at: ISO,
 *     patterns: [
 *       {
 *         template: "https://.../search?q={Q}&...",
 *         first_seen: ISO,
 *         last_success: ISO,
 *         success_count: N,
 *         fail_count: N
 *       }
 *     ]
 *   }
 *
 * Patterns are tried in order of (success_count - fail_count) desc, so
 * the most-reliable ones get tried first.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const CACHE_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-coles-api.json');
const VALIDATION_QUERY = 'milk';

function load() {
  if (!existsSync(CACHE_FILE)) return { updated_at: null, patterns: [] };
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (!Array.isArray(parsed.patterns)) parsed.patterns = [];
    return parsed;
  } catch {
    return { updated_at: null, patterns: [] };
  }
}

function save(data) {
  data.updated_at = new Date().toISOString();
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Try each cached pattern; return the first that validates, or null. */
export async function tryCachedApiPattern(page) {
  const data = load();
  if (data.patterns.length === 0) return null;

  // Score by success - fail, descending. Same-score ties broken by recency.
  const ordered = [...data.patterns].sort((a, b) => {
    const sa = (a.success_count || 0) - (a.fail_count || 0);
    const sb = (b.success_count || 0) - (b.fail_count || 0);
    if (sb !== sa) return sb - sa;
    return (b.last_success || '').localeCompare(a.last_success || '');
  });

  for (const p of ordered) {
    const isValid = await validatePattern(page, p.template);
    if (isValid) {
      p.last_success = new Date().toISOString();
      p.success_count = (p.success_count || 0) + 1;
      save(data);
      return p.template;
    } else {
      p.fail_count = (p.fail_count || 0) + 1;
    }
  }
  save(data);
  return null;
}

async function validatePattern(page, template) {
  try {
    const result = await page.evaluate(async (tpl, q) => {
      try {
        const url = tpl.replace('{Q}', encodeURIComponent(q));
        const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        // Loose heuristic: response should contain at least one product-shaped item.
        const lists = [
          data?.results, data?.products, data?.items,
          data?.pageProps?.searchResults?.results,
          data?.data?.search?.products,
          data?.data?.searchProducts?.results,
        ].filter(Array.isArray);
        const items = lists[0] || [];
        return { ok: items.length >= 3 };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    }, template, VALIDATION_QUERY);
    return !!result?.ok;
  } catch {
    return false;
  }
}

/** Record a freshly-discovered pattern. */
export function recordSuccessfulPattern(template) {
  if (!template) return;
  const data = load();
  const existing = data.patterns.find(p => p.template === template);
  const now = new Date().toISOString();
  if (existing) {
    existing.last_success = now;
    existing.success_count = (existing.success_count || 0) + 1;
  } else {
    data.patterns.push({
      template,
      first_seen: now,
      last_success: now,
      success_count: 1,
      fail_count: 0,
    });
  }
  save(data);
}
