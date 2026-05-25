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

// Fields to copy from scraper candidate → observation record + catalog.
// Anything the scrapers return that isn't in this list also gets
// preserved via `_raw` on the observation. Add to this list when the
// scraper grows new structured fields we want first-class queryability for.
const TRACKED_FIELDS = [
  'name', 'url', 'price', 'cup',
  // promos
  'was_price', 'is_on_special', 'save_amount',
  'promotion', 'promotion_text',
  'is_multibuy', 'multibuy_text',
  // identity / classification
  'brand', 'variety', 'size', 'package_size', 'unit_of_size', 'barcode',
  'department', 'category', 'sap_dept', 'sap_aisle', 'merchandise_hier',
  // media / description
  'image_url', 'description',
  // availability / restrictions
  'in_stock', 'is_available', 'age_restricted', 'restrictions',
  'purchase_limit_text', 'available_quantity', 'availability_type',
  'retail_limit', 'promo_limit', 'min_shelf_life',
  // search-result context
  'search_position', 'is_sponsored', 'ad_id', 'ad_type', 'ad_source',
  // ratings
  'rating', 'rating_count',
  // diet / additional attributes (Woolies-shaped array)
  'additional_attributes',
  // variants
  'variation_count',
  // DOM-fallback flag + sponsored-detection diagnostic
  '_source', 'sponsored_marker',
  // Full forensic blobs (raw API object OR DOM HTML for the tile)
  '_raw', '_raw_html',
];

function mergeFields(target, source) {
  for (const f of TRACKED_FIELDS) {
    if (source[f] !== undefined && source[f] !== null && source[f] !== '') {
      target[f] = source[f];
    }
  }
}

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
          // Last-write-wins for everything else within a run. Same
          // product appearing under multiple search queries shouldn't
          // differ, but if it does we keep the most recent.
          mergeFields(existing, c);
        } else {
          const fresh = {
            ts,
            store,
            product_id: pid,
            search_terms: searchTerm ? [searchTerm] : [],
          };
          mergeFields(fresh, c);
          byKey.set(key, fresh);
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
          // Copy every tracked field with a "latest_" prefix into the
          // catalog so the snapshot is queryable without scanning the
          // time-series log. Skip the _raw blob — kept only in the
          // append-only JSONL so the catalog stays compact.
          for (const f of TRACKED_FIELDS) {
            if (f.startsWith('_')) continue;
            if (obs[f] !== undefined && obs[f] !== null) {
              existing[`latest_${f}`] = obs[f];
            }
          }
          // Track every distinct price we've ever seen for this product
          // — gives an instant view of price churn without scanning the
          // full JSONL (which still has the per-observation timestamps).
          if (typeof obs.price === 'number') {
            existing.price_history = existing.price_history || [];
            const last = existing.price_history[existing.price_history.length - 1];
            if (!last || last.price !== obs.price) {
              existing.price_history.push({ ts: obs.ts, price: obs.price, cup: obs.cup });
            }
          }
          for (const t of obs.search_terms) {
            if (!existing.surfaced_by_searches.includes(t)) {
              existing.surfaced_by_searches.push(t);
            }
          }
        } else {
          const fresh = {
            store: obs.store,
            product_id: obs.product_id,
            first_seen: obs.ts,
            last_seen: obs.ts,
            observation_count: 1,
            surfaced_by_searches: [...obs.search_terms],
            price_history: typeof obs.price === 'number'
              ? [{ ts: obs.ts, price: obs.price, cup: obs.cup }]
              : [],
          };
          for (const f of TRACKED_FIELDS) {
            if (f.startsWith('_')) continue;
            if (obs[f] !== undefined && obs[f] !== null) {
              fresh[`latest_${f}`] = obs[f];
            }
          }
          catalog.products[key] = fresh;
        }
      }
      saveCatalog(catalog);
      return { observations: observations.length, catalog_size: Object.keys(catalog.products).length };
    },

    /** Number of unique products observed so far this run. */
    size() { return byKey.size; },
  };
}
