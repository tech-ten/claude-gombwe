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
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { findChrome, detachedSpawnOptions } from './platform.mjs';

const PORT = 19222;
const PROFILE_DIR  = join(homedir(), '.claude-gombwe', 'chrome-profile');
const DATA_DIR     = join(homedir(), '.claude-gombwe', 'data');
const WATCHLIST    = join(DATA_DIR, 'grocery-watchlist.json');
const PRICE_LOG    = join(DATA_DIR, 'grocery-prices.jsonl');
const DEALS_OUT    = join(DATA_DIR, 'grocery-deals-latest.json');

const MIN_WOOL = 75;   // free delivery threshold
const MIN_COLE = 50;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Chrome ───────────────────────────────────────────────────────────

async function connectChrome() {
  try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch {}
  if (!existsSync(PROFILE_DIR)) { console.error('No saved login. Run: gombwe grocery-setup'); process.exit(1); }
  const chromePath = findChrome();
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }
  spawn(chromePath, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.woolworths.com.au',
  ], detachedSpawnOptions()).unref();
  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch {}
  }
  console.error('Chrome failed to start.'); process.exit(1);
}

async function getPage(browser, domain) {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes(domain));
  if (!page) {
    page = await browser.newPage();
    await page.goto(`https://www.${domain}`, { waitUntil: 'networkidle2', timeout: 15000 });
    await wait(2000);
  }
  return page;
}

// ── Search APIs (mirror grocery-buy.mjs, but read-only) ──────────────

async function woolworthsBest(page, term) {
  return page.evaluate(async (q) => {
    try {
      const res = await fetch(`https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageSize=5`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const products = (data?.Products || []).flatMap(p => p?.Products || []).filter(Boolean);
      if (!products.length) return null;
      let cheapest = null;
      for (const p of products) {
        const price = p?.Price ?? p?.InstorePrice;
        if (typeof price !== 'number') continue;
        if (!cheapest || price < cheapest.price) {
          cheapest = { name: p?.DisplayName || p?.Name || '?', price, stockcode: p?.Stockcode || null };
        }
      }
      return cheapest;
    } catch { return null; }
  }, term);
}

async function colesBest(page, term) {
  return page.evaluate(async (q) => {
    try {
      const res = await fetch(`https://www.coles.com.au/api/bff/products?q=${encodeURIComponent(q)}&page=1`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const products = data?.pageProps?.searchResults?.results || data?.results || [];
      if (!products.length) return null;
      let cheapest = null;
      for (const p of products) {
        const price = p?.pricing?.now ?? p?.pricing?.normal;
        if (typeof price !== 'number') continue;
        if (!cheapest || price < cheapest.price) {
          cheapest = { name: p?.name || '?', price };
        }
      }
      return cheapest;
    } catch { return null; }
  }, term);
}

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

async function pollOnce(items) {
  const browser = await connectChrome();
  const wPage = await getPage(browser, 'woolworths.com.au');
  const cPage = await getPage(browser, 'coles.com.au');

  const ts = new Date().toISOString();
  const records = [];

  for (const item of items) {
    const terms = item.search_terms?.length ? item.search_terms : [item.name];
    let wBest = null, cBest = null;
    for (const t of terms) {
      if (!wBest) wBest = await woolworthsBest(wPage, t);
      if (!cBest) cBest = await colesBest(cPage, t);
      if (wBest && cBest) break;
      await wait(200);
    }
    const rec = {
      ts, item: item.name,
      woolworths_price: wBest?.price ?? null, woolworths_name: wBest?.name ?? null,
      coles_price:      cBest?.price ?? null, coles_name:      cBest?.name ?? null,
    };
    appendPrice(rec);
    records.push({ item, current: { woolworths: wBest, coles: cBest } });
    process.stdout.write(`  ${item.name.padEnd(45)}  W: $${wBest?.price?.toFixed(2) ?? '   -'}  C: $${cBest?.price?.toFixed(2) ?? '   -'}\n`);
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
const dealsOnly = args.includes('--deals');
const asJson    = args.includes('--json');

async function main() {
  const watchlist = loadWatchlist();
  const items = watchlist.items || [];
  if (!items.length) { console.error('Watchlist is empty.'); process.exit(1); }

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
    records = await pollOnce(items);
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
