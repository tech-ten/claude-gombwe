/**
 * GROCERY FORENSICS — append-only logs of the scraping process itself.
 *
 * The product price log captures WHAT we observed. These logs capture
 * HOW we got there — every search call, every classifier decision, every
 * Coles API discovery attempt. Useful when something goes wrong and
 * we want to know which query returned what, or what shortlist Haiku
 * was looking at when it picked a particular product.
 *
 * Files (all append-only JSONL in ~/.claude-gombwe/data/):
 *
 *   grocery-searches.jsonl
 *     One row per scraper search call.
 *     { ts, store, query, result_count, page, ms?, ok }
 *
 *   grocery-classifier-decisions.jsonl
 *     One row per Haiku invocation.
 *     { ts, item, store, shortlist_count, shortlist, picked_index, source, raw, ms }
 *     shortlist is the exact list passed to Haiku, so we can reconstruct
 *     WHY any given pick was made.
 *
 *   grocery-api-discovery.jsonl
 *     One row per Coles API sniff attempt (success OR failure).
 *     { ts, captured_urls, picked_template, success }
 *     captured_urls is every JSON response the page made during the
 *     sniff window — explains why discovery failed when it did.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');
const SEARCH_LOG = join(DATA_DIR, 'grocery-searches.jsonl');
const CLASSIFIER_LOG = join(DATA_DIR, 'grocery-classifier-decisions.jsonl');
const DISCOVERY_LOG = join(DATA_DIR, 'grocery-api-discovery.jsonl');

function append(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (err) {
    // Logging must never break the pipeline — swallow errors.
    console.warn(`[forensics] write failed for ${path}: ${err.message}`);
  }
}

export function logSearch({ store, query, result_count, ms, ok = true, error = null }) {
  append(SEARCH_LOG, {
    ts: new Date().toISOString(),
    store, query, result_count, ms, ok,
    ...(error ? { error } : {}),
  });
}

/** Persist a classifier decision. Pass the shortlist that was actually
 *  sent to Haiku (after rankAndCap), the index Haiku picked (or null
 *  for "none"), the raw response, and the source label. */
export function logClassifierDecision({
  item, store, shortlist, picked_index, picked_id,
  source, raw, ms,
}) {
  append(CLASSIFIER_LOG, {
    ts: new Date().toISOString(),
    item,
    store,
    shortlist_count: shortlist?.length || 0,
    // Trim shortlist to essentials per candidate — keeps the log small
    // while preserving the full audit trail (we can look up full
    // product details by product_id in the catalog).
    shortlist: (shortlist || []).map(c => ({
      product_id: c.product_id,
      name: c.name,
      price: c.price,
      cup: c.cup,
    })),
    picked_index,
    picked_id,
    source,
    raw,
    ms,
  });
}

export function logDiscoveryAttempt({ store = 'coles', captured_urls, picked_template, success }) {
  append(DISCOVERY_LOG, {
    ts: new Date().toISOString(),
    store,
    captured_count: captured_urls?.length || 0,
    captured_urls: captured_urls || [],
    picked_template: picked_template || null,
    success: !!success,
  });
}
