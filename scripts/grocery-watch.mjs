#!/usr/bin/env node
/**
 * GROCERY WATCH — daily price poll + deal detector.
 *
 * Reads ~/.claude-gombwe/data/grocery-watchlist.json, queries Woolworths +
 * Coles for each item's current best price, appends one observation per item
 * to ~/.claude-gombwe/data/grocery-prices.jsonl, then computes:
 *   - all-time-low per item per store
 *   - which items are CURRENTLY below the user's max_price ceiling (eligible)
 *   - whether eligible items at either store sum to >= free-delivery threshold
 *
 * Output modes:
 *   node scripts/grocery-watch.mjs              → poll + write log + console summary
 *   node scripts/grocery-watch.mjs --deals      → don't poll, just report current deals
 *   node scripts/grocery-watch.mjs --json       → poll, emit JSON (for the alerter/cron)
 *
 * The poller uses the same authenticated Chrome profile as grocery-buy.mjs.
 * Price observations live in JSONL forever — no DB needed.
 *
 * Notification of "rock-bottom" items is delegated to scripts/grocery-alert.mjs
 * (SMS/WhatsApp). This script just writes the data + prints/JSON-emits the
 * snapshot; the alerter decides who to nudge.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import {
  wait, jitter,
  connectChrome, getPage,
  woolworthsSearch, discoverColesApi, colesSearch,
  productMatches,
  MIN_ORDER_WOOLWORTHS as MIN_WOOL,
  MIN_ORDER_COLES as MIN_COLE,
} from './grocery-lib.mjs';
import { isCalibrationStale, runCalibration } from './grocery-calibrate.mjs';
import { resolveBestMatch, loadResolutions, saveResolutions } from './grocery-resolutions.mjs';
import { newObservationCollector } from './grocery-products.mjs';

const DATA_DIR     = join(homedir(), '.claude-gombwe', 'data');
const WATCHLIST    = join(DATA_DIR, 'grocery-watchlist.json');
const PRICE_LOG    = join(DATA_DIR, 'grocery-prices.jsonl');
const DEALS_OUT    = join(DATA_DIR, 'grocery-deals-latest.json');

// Chrome plumbing + search primitives + matcher all live in grocery-lib.mjs.
// Per-poll Coles API endpoint (captured once at startup) is held below.
let colesApiPattern = null;

// ── Watchlist + history I/O ──────────────────────────────────────────

function loadWatchlist() {
  if (!existsSync(WATCHLIST)) {
    console.error(`No watchlist at ${WATCHLIST}. Bootstrap it (see docs).`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(WATCHLIST, 'utf-8'));
}

function loadPriceHistory() {
  if (!existsSync(PRICE_LOG)) return [];
  const out = [];
  for (const line of readFileSync(PRICE_LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function appendPrice(rec) {
  mkdirSync(dirname(PRICE_LOG), { recursive: true });
  appendFileSync(PRICE_LOG, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

function lowsFromHistory(history) {
  // mac of { itemKey → { woolworths: low, coles: low } }
  const out = new Map();
  for (const rec of history) {
    const cur = out.get(rec.item) || { woolworths: null, coles: null };
    if (rec.woolworths_price != null && (cur.woolworths == null || rec.woolworths_price < cur.woolworths)) cur.woolworths = rec.woolworths_price;
    if (rec.coles_price      != null && (cur.coles      == null || rec.coles_price      < cur.coles))      cur.coles      = rec.coles_price;
    out.set(rec.item, cur);
  }
  return out;
}

// ── Deal logic ───────────────────────────────────────────────────────

function pickBestPrice(woolworths, coles) {
  const w = woolworths?.price ?? Infinity;
  const c = coles?.price ?? Infinity;
  if (w === Infinity && c === Infinity) return { store: null, price: null };
  return w <= c ? { store: 'woolworths', price: w } : { store: 'coles', price: c };
}

/** Decide if an item is "rock bottom" right now.
 *  Definition: at or below the user's max_price ceiling.
 *  Bonus: also report the discount vs all-time-low so we can tell "matched the floor" from "decent but not best ever". */
function classifyItem(item, current, lows) {
  const itemLows = lows.get(item.name) || { woolworths: null, coles: null };
  const best = pickBestPrice(current.woolworths, current.coles);
  if (best.price == null) return { ...item, status: 'no-data', current, lows: itemLows, best };
  const atOrBelowCeiling = best.price <= item.max_price;
  const allTimeLow = Math.min(itemLows.woolworths ?? Infinity, itemLows.coles ?? Infinity, best.price);
  const matchesFloor = Math.abs(best.price - allTimeLow) < 0.51;   // within 50c of best-ever
  const status =
    !atOrBelowCeiling ? 'wait' :
    matchesFloor      ? 'rock-bottom' :
    'eligible';
  return { ...item, status, current, lows: itemLows, best, all_time_low: allTimeLow };
}

// ── Free-delivery cart planning ───────────────────────────────────────

function planCarts(classified) {
  // For every item flagged 'rock-bottom' or 'eligible', drop it in the store
  // that has the cheaper price for it. Then see which store's cart exceeds
  // the free-delivery threshold.
  const wCart = [], cCart = [];
  for (const c of classified) {
    if (c.status !== 'rock-bottom' && c.status !== 'eligible') continue;
    const w = c.current.woolworths?.price;
    const cc = c.current.coles?.price;
    const pickW = (w != null && (cc == null || w <= cc));
    if (pickW) wCart.push({ name: c.name, price: w, status: c.status });
    else if (cc != null) cCart.push({ name: c.name, price: cc, status: c.status });
  }
  const wTotal = wCart.reduce((s, x) => s + x.price, 0);
  const cTotal = cCart.reduce((s, x) => s + x.price, 0);
  return {
    woolworths: { items: wCart, total: +wTotal.toFixed(2), free_delivery: wTotal >= MIN_WOOL, threshold: MIN_WOOL },
    coles:      { items: cCart, total: +cTotal.toFixed(2), free_delivery: cTotal >= MIN_COLE, threshold: MIN_COLE },
  };
}

// ── Poll + report ────────────────────────────────────────────────────

async function pollOnce(items, { forceReclassify = false } = {}) {
  const resolutionCache = loadResolutions();
  const browser = await connectChrome();
  const wPage = await getPage(browser, 'woolworths.com.au');
  const cPage = await getPage(browser, 'coles.com.au');

  // One-shot discovery of Coles' internal search endpoint — saves us a
  // full page navigation per query. Falls back to DOM scrape if discovery
  // doesn't find anything.
  colesApiPattern = await discoverColesApi(cPage);
  console.log(colesApiPattern
    ? `  Coles via internal API: ${colesApiPattern.slice(0, 80)}…`
    : `  Coles via DOM scrape (slower fallback).`);

  const ts = new Date().toISOString();
  const records = [];
  // Captures every candidate from every search across the whole run
  // (not just the picked one) into the product time series.
  const observations = newObservationCollector(ts);

  for (const item of items) {
    const terms = item.search_terms?.length ? item.search_terms : [item.name];

    // Accumulate ALL candidate products from every search term, then pick
    // the cheapest that genuinely confirms (size + pack + unit + soft price
    // floor). This handles cross-brand comparables — searching "salted
    // butter 500g" and seeing Coles brand, Devondale, Western Star all at
    // 500g; cheapest validated wins.
    const wAll = [];
    const cAll = [];
    for (const t of terms) {
      const ws = await woolworthsSearch(wPage, t);
      if (Array.isArray(ws)) { wAll.push(...ws); observations.observe('woolworths', t, ws); }
      const cs = await colesSearch(cPage, t, colesApiPattern);
      if (Array.isArray(cs)) { cAll.push(...cs); observations.observe('coles', t, cs); }
      // Stop early if we have enough candidates
      if (wAll.length > 8 && cAll.length > 8) break;
      // Jittered delay between search terms — defeats mechanical-pattern
      // bot detection that flags consistent inter-request timing.
      await jitter(200, 700);
    }
    // Jittered delay between watchlist items — same idea, longer scale.
    await jitter(800, 2500);

    // Cheap regex pre-filter: drop obvious junk (wrong size/pack, processed
    // variants the watchlist didn't ask for, no name overlap, etc.) so the
    // LLM classifier sees a tight shortlist. Soft $0.10 floor catches
    // negative-price scraping artefacts.
    const confirmed = (p) =>
      typeof p.price === 'number' && p.price >= 0.10
      && productMatches(item.name, p.name, p.cup, { requires: item.requires });

    const wValid = wAll.filter(confirmed).sort((a, b) => a.price - b.price);
    const cValid = cAll.filter(confirmed).sort((a, b) => a.price - b.price);

    // Resolve picks via the resolution cache — Haiku is only invoked
    // on cache miss (new item, or previously-picked product no longer
    // in search results). Both stores resolved in parallel.
    const [wPick, cPick] = await Promise.all([
      resolveBestMatch(item, wValid, 'woolworths', { forceReclassify, cache: resolutionCache }),
      resolveBestMatch(item, cValid, 'coles',      { forceReclassify, cache: resolutionCache }),
    ]);
    // Persist per-item so a crash mid-run still saves progress.
    saveResolutions(resolutionCache);
    const wBest = wPick.picked;
    const cBest = cPick.picked;

    // Capture rejects for forensics — cheapest reject per store so we can
    // see WHY confirmation failed (helps the user iterate search_terms).
    const wReject = !wBest && wAll.length ? wAll.slice().sort((a, b) => a.price - b.price)[0] : null;
    const cReject = !cBest && cAll.length ? cAll.slice().sort((a, b) => a.price - b.price)[0] : null;

    const rec = {
      ts, item: item.name,
      woolworths_price: wBest?.price ?? null,
      woolworths_name:  wBest?.name  ?? null,
      coles_price:      cBest?.price ?? null,
      coles_name:       cBest?.name  ?? null,
      candidates_seen:  { woolworths: wAll.length, coles: cAll.length },
      candidates_valid: { woolworths: wValid.length, coles: cValid.length },
      classifier:       { woolworths: wPick.source, coles: cPick.source },
      ...(wReject ? { _rejected_w: { name: wReject.name, price: wReject.price } } : {}),
      ...(cReject ? { _rejected_c: { name: cReject.name, price: cReject.price } } : {}),
    };
    appendPrice(rec);
    records.push({ item, current: { woolworths: wBest, coles: cBest } });

    const fmtPick = (best, all, src) => best
      ? `$${best.price.toFixed(2)} (${src})`
      : (all.length ? `none (${src}, ${all.length} seen)` : '-');
    const wDisplay = fmtPick(wBest, wAll, wPick.source);
    const cDisplay = fmtPick(cBest, cAll, cPick.source);
    process.stdout.write(`  ${item.name.padEnd(45).slice(0, 45)}  W: ${wDisplay.padStart(22)}  C: ${cDisplay.padStart(22)}\n`);
  }

  const obsStats = observations.flush();
  if (obsStats.observations > 0) {
    console.log(`\n  Captured ${obsStats.observations} product observations (catalog: ${obsStats.catalog_size} products total).`);
  }

  browser.disconnect();
  return records;
}

function buildDealsReport(records, lows) {
  const classified = records.map(({ item, current }) => classifyItem(item, current, lows));
  const carts = planCarts(classified);
  return {
    generated_at: new Date().toISOString(),
    items: classified,
    rock_bottom: classified.filter(c => c.status === 'rock-bottom'),
    eligible:    classified.filter(c => c.status === 'eligible'),
    waiting:     classified.filter(c => c.status === 'wait'),
    no_data:     classified.filter(c => c.status === 'no-data'),
    carts,
  };
}

function printSummary(report) {
  console.log(`\n  ── DEALS SNAPSHOT ──`);
  console.log(`  Rock-bottom (≤ ceiling, near all-time-low):  ${report.rock_bottom.length}`);
  console.log(`  Eligible    (≤ ceiling, not best-ever):      ${report.eligible.length}`);
  console.log(`  Waiting     (above ceiling — don't buy yet): ${report.waiting.length}`);
  console.log(`  No data     (search didn't find product):    ${report.no_data.length}`);
  console.log(`\n  ── CART PLAN (best-store per item) ──`);
  const { woolworths: w, coles: c } = report.carts;
  console.log(`  Woolworths: ${w.items.length} items, $${w.total} ${w.free_delivery ? '✓ free delivery' : `(need $${(MIN_WOOL - w.total).toFixed(2)} more)`}`);
  console.log(`  Coles:      ${c.items.length} items, $${c.total} ${c.free_delivery ? '✓ free delivery' : `(need $${(MIN_COLE - c.total).toFixed(2)} more)`}`);
  if (report.rock_bottom.length) {
    console.log(`\n  Rock-bottom items right now:`);
    for (const r of report.rock_bottom.slice(0, 15)) {
      console.log(`    • ${r.name.padEnd(40)} @ $${r.best.price.toFixed(2)} (${r.best.store}, ceiling $${r.max_price})`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dealsOnly         = args.includes('--deals');
const asJson            = args.includes('--json');
const skipCalibration   = args.includes('--skip-calibration');
const forceCalibration  = args.includes('--force-calibration');
const forceReclassify   = args.includes('--force-reclassify');

async function main() {
  const watchlist = loadWatchlist();
  const items = watchlist.items || [];
  if (!items.length) { console.error('Watchlist is empty.'); process.exit(1); }

  // Run the calibrator first when stale. Calibration is a no-op for the
  // deals-only path (no fresh scraping happening). Skip when explicitly
  // suppressed (e.g. running grocery-watch from a tight test loop).
  if (!dealsOnly && !skipCalibration && (forceCalibration || isCalibrationStale(48))) {
    console.log('  Calibration is stale — running calibrator first…\n');
    try {
      await runCalibration();
    } catch (err) {
      console.warn(`  ⚠ Calibration failed (continuing with watch): ${err.message}`);
    }
    console.log('');
  }

  let records;
  if (dealsOnly) {
    // Don't poll, just classify from the latest record per item in the price log.
    const history = loadPriceHistory();
    const latestByItem = new Map();
    for (const rec of history) {
      const cur = latestByItem.get(rec.item);
      if (!cur || rec.ts > cur.ts) latestByItem.set(rec.item, rec);
    }
    records = items.map(item => {
      const latest = latestByItem.get(item.name);
      return {
        item,
        current: {
          woolworths: latest?.woolworths_price != null ? { price: latest.woolworths_price, name: latest.woolworths_name } : null,
          coles:      latest?.coles_price      != null ? { price: latest.coles_price,      name: latest.coles_name      } : null,
        },
      };
    });
  } else {
    console.log(`  Polling ${items.length} items across Woolworths + Coles…\n`);
    records = await pollOnce(items, { forceReclassify });
  }

  const history = loadPriceHistory();
  const lows = lowsFromHistory(history);
  const report = buildDealsReport(records, lows);

  // Always write the latest snapshot to a known path so alerter + dashboard can read it
  mkdirSync(dirname(DEALS_OUT), { recursive: true });
  writeFileSync(DEALS_OUT, JSON.stringify(report, null, 2), { mode: 0o600 });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
    console.log(`\n  Snapshot written to ${DEALS_OUT}`);
    console.log(`  Price log: ${PRICE_LOG} (${history.length} historical observations)\n`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
