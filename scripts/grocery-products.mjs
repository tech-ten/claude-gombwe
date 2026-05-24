/**
 * GROCERY PRODUCTS — full Coles + Woolworths catalog + price time series.
 *
 * The existing grocery-prices.jsonl is curated (one record per watchlist
 * item per scrape, just the picked product). That throws away every
 * candidate that wasn't picked — losing the bulk of the data we scrape.
 *
 * This module records EVERY candidate every scraper returns:
 *
 *   - grocery-product-prices.jsonl (append-only)
 *       Time series. One record per (product, scrape run), aggregated
 *       within-run so a product surfaced by multiple searches in the
 *       same run gets ONE row tagged with all the search terms that
 *       returned it. Fields: ts, store, product_id, name, url, price,
 *       cup, search_terms.
 *
 *   - grocery-products.json (current snapshot of the catalog)
 *       Per product_id: first_seen, last_seen, observation_count,
 *       latest name/url/price/cup, surfaced_by_searches union.
 *
 * Why this matters: Coles + Woolworths are an Australian duopoly with
 * no public price-transparency dataset. The time series captured here
 * compounds into a uniquely useful asset for advocacy, journalism,
 * arbitrage, or downstream SaaS. Saving it costs almost nothing now.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { productKey } from './grocery-resolutions.mjs';

const DATA_DIR    = join(homedir(), '.claude-gombwe', 'data');
const CATALOG     = join(DATA_DIR, 'grocery-products.json');
const PRICE_LOG   = join(DATA_DIR, 'grocery-product-prices.jsonl');

function loadCatalog() {
  if (!existsSync(CATALOG)) {
    return { updated_at: null, stats: { total: 0, coles: 0, woolies: 0 }, products: {} };
  }
  try {
    const c = JSON.parse(readFileSync(CATALOG, 'utf8'));
    if (!c.products) c.products = {};
    if (!c.stats) c.stats = { total: 0, coles: 0, woolies: 0 };
    return c;
  } catch {
    return { updated_at: null, stats: { total: 0, coles: 0, woolies: 0 }, products: {} };
  }
}

function saveCatalog(catalog) {
  catalog.updated_at = new Date().toISOString();
  catalog.stats = {
    total: Object.keys(catalog.products).length,
    coles: Object.values(catalog.products).filter(p => p.store === 'coles').length,
    woolies: Object.values(catalog.products).filter(p => p.store === 'woolworths').length,
  };
  mkdirSync(dirname(CATALOG), { recursive: true });
  writeFileSync(CATALOG, JSON.stringify(catalog, null, 2), { mode: 0o600 });
}

/**
 * Create an in-memory observation collector for a single scrape run.
 * Call .observe() for every candidate from every search, then .flush()
 * once at the end of the run to persist to JSONL + update the catalog.
 *
 * Aggregating within-run dedupes products that get returned by multiple
 * search terms (e.g. "Coles Simply Salted Butter" appearing under both
 * "salted butter" and "butter") — one row per product per run, with
 * the set of surfacing search terms attached.
 */
export function newObservationCollector(ts = new Date().toISOString()) {
  /** key = `${store}:${product_id}` → observation */
  const byKey = new Map();

  return {
    /**
     * @param {string} store - 'coles' | 'woolworths'
     * @param {string} searchTerm - the query that produced this candidate
     * @param {Array} candidates - raw scraper output [{name, price, url, cup, stockcode?}, ...]
     */
    observe(store, searchTerm, candidates) {
      if (!Array.isArray(candidates)) return;
      for (const c of candidates) {
        const pid = productKey(c, store);
        if (!pid) continue;  // can't track without stable ID
        const key = `${store}:${pid}`;
        const existing = byKey.get(key);
        if (existing) {
          if (searchTerm && !existing.search_terms.includes(searchTerm)) {
            existing.search_terms.push(searchTerm);
          }
          // Prefer the most-recent name/price (last write wins within run —
          // shouldn't differ within a single run but covers edge cases).
          if (c.name) existing.name = c.name;
          if (typeof c.price === 'number') existing.price = c.price;
          if (c.cup) existing.cup = c.cup;
          if (c.url) existing.url = c.url;
        } else {
          byKey.set(key, {
            ts,
            store,
            product_id: pid,
            name: c.name || null,
            url: c.url || null,
            price: typeof c.price === 'number' ? c.price : null,
            cup: c.cup || null,
            search_terms: searchTerm ? [searchTerm] : [],
          });
        }
      }
    },

    /** Persist observations to the time series + update the catalog. */
    flush() {
      const observations = Array.from(byKey.values());
      if (observations.length === 0) return { observations: 0, catalog_size: null };

      mkdirSync(dirname(PRICE_LOG), { recursive: true });
      const lines = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
      appendFileSync(PRICE_LOG, lines, { mode: 0o600 });

      const catalog = loadCatalog();
      for (const obs of observations) {
        const key = `${obs.store}:${obs.product_id}`;
        const existing = catalog.products[key];
        if (existing) {
          existing.last_seen = obs.ts;
          existing.observation_count = (existing.observation_count || 0) + 1;
          existing.latest_name = obs.name;
          existing.latest_url = obs.url;
          existing.latest_price = obs.price;
          existing.latest_cup = obs.cup;
          for (const t of obs.search_terms) {
            if (!existing.surfaced_by_searches.includes(t)) {
              existing.surfaced_by_searches.push(t);
            }
          }
        } else {
          catalog.products[key] = {
            store: obs.store,
            product_id: obs.product_id,
            first_seen: obs.ts,
            last_seen: obs.ts,
            observation_count: 1,
            latest_name: obs.name,
            latest_url: obs.url,
            latest_price: obs.price,
            latest_cup: obs.cup,
            surfaced_by_searches: [...obs.search_terms],
          };
        }
      }
      saveCatalog(catalog);
      return { observations: observations.length, catalog_size: Object.keys(catalog.products).length };
    },

    /** Number of unique products observed so far this run. */
    size() { return byKey.size; },
  };
}
