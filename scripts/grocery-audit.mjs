#!/usr/bin/env node
/**
 * GROCERY RESOLUTION AUDIT
 *
 * Walks every cached resolution and flags ones whose picked product
 * looks wrong vs the watchlist item, so we can force-reclassify them.
 *
 * Run:
 *   node scripts/grocery-audit.mjs                # report + list flagged
 *   node scripts/grocery-audit.mjs --json         # machine-readable
 *   node scripts/grocery-audit.mjs --flagged     # just the names of flagged items
 *
 * Flag signals (any one fires the flag):
 *   1. Distinctive word missing: watchlist has a content word that the
 *      picked product name lacks (catches variant-confusion like
 *      "Cold Power Advanced PLUS" matched against "Advanced CLEAN").
 *   2. Price floor breach: picked price is < FLOOR_FRACTION of
 *      max_price (a very cheap pick usually means wrong product).
 *   3. Brand mismatch: watchlist names a brand explicitly and the
 *      picked product doesn't carry it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { significantWords, normaliseName, stripNotes } from './grocery-lib.mjs';

const DATA_DIR    = join(homedir(), '.claude-gombwe', 'data');
const WATCHLIST   = join(DATA_DIR, 'grocery-watchlist.json');
const RESOLUTIONS = join(DATA_DIR, 'grocery-resolutions.json');

const FLOOR_FRACTION = 0.35;  // picked < 35% of max_price → suspect
const MIN_WORD_LEN   = 4;     // word must be ≥ 4 chars to count as distinctive

// Brand-line variant words we want STRICT matching on. If the watchlist
// has one of these, the picked product must too.
const STRICT_QUALIFIERS = new Set([
  'plus','premium','original','sensitive','concentrate','gentle',
  'professional','classic','ultimate','advanced','fresh','pure',
  'natural','organic','select','simply','gold','pro','active',
  'lemon','apple','orange','mint','eucalyptus','lavender','rose',
  'crunchy','smooth','crispy','crisp','wholegrain','whole',
  'unsalted','salted','light','full','low','reduced','extra',
  'plain','spicy','sweet','sour','garlic','herb',
]);

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function audit(item, store, resolution) {
  const flags = [];
  const wlClean = stripNotes(item.name);
  const wlWords = new Set(significantWords(wlClean));
  const pickedNorm = normaliseName(resolution.product_name || '');
  const pickedWords = new Set(pickedNorm.split(/\s+/));

  // 1. Distinctive long word missing
  const longWanted = [...wlWords].filter(w => w.length >= MIN_WORD_LEN);
  const longMissing = longWanted.filter(w => !pickedWords.has(w));
  if (longMissing.length > 0 && longWanted.length > 0) {
    // Allow ONE missing word (covers minor brand/variant differences)
    // but two or more = serious mismatch
    if (longMissing.length >= 2 || longMissing.length === longWanted.length) {
      flags.push(`missing-words: [${longMissing.join(', ')}]`);
    } else if (longMissing.some(w => STRICT_QUALIFIERS.has(w))) {
      // A single missing word is fatal if it's a strict qualifier
      flags.push(`missing-qualifier: "${longMissing.join(', ')}"`);
    }
  }

  // 2. Strict-qualifier mismatch (catches Cold Power Plus → Clean)
  const wlQuals = longWanted.filter(w => STRICT_QUALIFIERS.has(w));
  const pickedQuals = [...pickedWords].filter(w => STRICT_QUALIFIERS.has(w));
  for (const q of wlQuals) {
    if (!pickedWords.has(q)) {
      // Already covered by missing-qualifier above; only flag if not
      // already flagged
      if (!flags.some(f => f.includes(q))) {
        flags.push(`qualifier-mismatch: watchlist has "${q}", picked has [${pickedQuals.join(',') || 'none'}]`);
      }
    }
  }

  // 3. Price floor breach — pick is too cheap for the ceiling
  if (typeof item.max_price === 'number'
      && typeof resolution.latest_price === 'number'
      && resolution.latest_price < item.max_price * FLOOR_FRACTION) {
    flags.push(`too-cheap: $${resolution.latest_price} < ${(FLOOR_FRACTION * 100).toFixed(0)}% of ceiling $${item.max_price}`);
  }

  return flags;
}

function main() {
  const watchlist = loadJSON(WATCHLIST, { items: [] });
  const resolutions = loadJSON(RESOLUTIONS, { resolutions: {} });

  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const flaggedOnly = args.includes('--flagged');

  const wlByName = new Map(watchlist.items.map(it => [it.name, it]));
  const findings = [];

  for (const [itemName, stores] of Object.entries(resolutions.resolutions)) {
    const item = wlByName.get(itemName);
    if (!item) continue;  // watchlist entry deleted; ignore stale resolution
    for (const store of ['coles', 'woolworths']) {
      const res = stores[store];
      if (!res?.product_id) continue;
      // Read latest price from resolution; falls back to product_name only.
      const enriched = { ...res, latest_price: null };
      // Resolutions don't store the price (catalog does). For audit we
      // need price → load catalog lazily.
      enriched.latest_price = getLatestPriceFor(store, res.product_id);
      const flags = audit(item, store, enriched);
      if (flags.length > 0) {
        findings.push({
          item: itemName,
          store,
          picked_name: res.product_name,
          picked_price: enriched.latest_price,
          max_price: item.max_price,
          flags,
        });
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ findings, count: findings.length }, null, 2));
    return;
  }
  if (flaggedOnly) {
    const itemNames = [...new Set(findings.map(f => f.item))];
    for (const n of itemNames) console.log(n);
    return;
  }

  console.log(`=== Audit ${watchlist.items.length} watchlist items, ${Object.keys(resolutions.resolutions).length} have resolutions ===\n`);
  if (findings.length === 0) {
    console.log('✓ All resolutions look clean.');
    return;
  }
  console.log(`⚠ ${findings.length} resolution${findings.length === 1 ? '' : 's'} flagged across ${new Set(findings.map(f => f.item)).size} item${findings.length === 1 ? '' : 's'}:\n`);
  for (const f of findings) {
    console.log(`  ▌ ${f.item}  [${f.store}]`);
    console.log(`    picked: "${f.picked_name}"  @ $${f.picked_price ?? '?'}  (ceiling $${f.max_price ?? '?'})`);
    for (const fl of f.flags) console.log(`      ⚠ ${fl}`);
    console.log('');
  }
}

let catalogCache = null;
function getLatestPriceFor(store, productId) {
  if (!catalogCache) {
    const path = join(DATA_DIR, 'grocery-products.json');
    catalogCache = loadJSON(path, { products: {} });
  }
  const storeKey = store === 'woolworths' ? 'woolworths' : 'coles';
  const key = `${storeKey}:${productId}`;
  return catalogCache.products[key]?.latest_price ?? null;
}

main();
