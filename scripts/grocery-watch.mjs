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

// ── Product confirmation (not blind price ranges) ────────────────────
//
// A returned product is a real match for our watchlist item only when:
//   - every size token (e.g. 4L, 500g, 1kg, 220g) in the watchlist name
//     also appears in the product name (normalised),
//   - the pack count matches (12 pack ≠ 4 pack ≠ each),
//   - the unit type matches: a "per kg" watchlist item rejects "each"
//     products and vice versa.
//
// Price is only used as a last-line floor ($0.10 minimum) — never as the
// primary judge, because legit half-price specials and bad matches can
// overlap on price alone.

function normaliseName(s) {
  return String(s || '').toLowerCase()
    .replace(/[-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTokens(itemName) {
  const norm = normaliseName(itemName);
  const tokens = { sizes: [], pack: null, perKg: false, each: false };
  // Volumes / weights like 4L, 500ml, 1kg, 1.4kg, 220g, 75L
  const sizeRe = /(\d+(?:\.\d+)?)\s?(l|ml|g|kg|cl)\b/g;
  let m;
  while ((m = sizeRe.exec(norm)) !== null) tokens.sizes.push(`${m[1]}${m[2]}`);
  // Pack counts: "12 pack", "24 pack", "8 pack", "12pk", "5 pk"
  const packRe = /(\d+)\s?(pack|pk)\b/;
  const pm = norm.match(packRe);
  if (pm) tokens.pack = parseInt(pm[1], 10);
  // Unit types
  if (norm.includes('per kg') || /\bper\s+kg\b/.test(norm)) tokens.perKg = true;
  if (norm.includes(' each') || norm.endsWith(' each')) tokens.each = true;
  return tokens;
}

function productMatches(watchlistName, productName, unitString) {
  const want = extractTokens(watchlistName);
  const got = normaliseName(productName);
  const unit = normaliseName(unitString || '');

  // Size tokens must all appear in product name
  for (const s of want.sizes) {
    // Accept "4l" matching "4l", "4 l", "4 litre", "4 litres"
    const num = s.replace(/[a-z]/g, '');
    const u = s.replace(/[\d.]/g, '');
    const altLitres = u === 'l' ? `${num} litre` : null;
    const altMl     = u === 'ml' ? `${num} mil` : null;
    if (!got.includes(s)
        && !got.includes(`${num} ${u}`)
        && !(altLitres && got.includes(altLitres))
        && !(altMl && got.includes(altMl))) {
      return false;
    }
  }
  // Pack count must match
  if (want.pack !== null) {
    const packRe = new RegExp(`\\b${want.pack}\\s?(pack|pk)\\b`);
    if (!packRe.test(got)) return false;
  }
  // Unit type
  if (want.perKg) {
    // Product must indicate per-kg pricing somewhere (name or unit-string)
    const looksKg = /\bper\s+kg\b/.test(got) || /\$\s?[\d.]+\s*\/\s*\d*\s*kg/.test(unit) || /per\s+kg/.test(unit);
    if (!looksKg) return false;
  }
  if (want.each && !want.perKg) {
    // Must be sold each (not per kg)
    const looksEach = /\beach\b/.test(got) || /\beach\b/.test(unit);
    if (!looksEach) return false;
  }
  return true;
}

// ── Search APIs ──────────────────────────────────────────────────────

async function woolworthsBest(page, term) {
  return page.evaluate(async (q) => {
    try {
      const res = await fetch(`https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageSize=10`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const products = (data?.Products || []).flatMap(p => p?.Products || []).filter(Boolean);
      // Return ALL viable products so the caller can pick the cheapest CONFIRMED one
      return products.map(p => ({
        name: p?.DisplayName || p?.Name || '?',
        price: typeof p?.Price === 'number' ? p.Price : (typeof p?.InstorePrice === 'number' ? p.InstorePrice : null),
        cup: p?.CupString || '',                  // e.g. "$3.55 / Per 2L" — unit price string
        stockcode: p?.Stockcode || null,
      })).filter(x => typeof x.price === 'number');
    } catch { return []; }
  }, term);
}

// Coles internal endpoint, captured at startup by sniffing the SPA's own
// search requests. Once we know the URL pattern we hit it directly via
// page.evaluate(fetch) — same low-latency model as Woolworths.
let colesApiPattern = null;
let colesApiHeaders = null;

async function discoverColesApi(page) {
  console.log('  Discovering Coles internal search endpoint…');
  const candidates = [];
  const onResp = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('coles.com.au')) return;
      if (response.status() !== 200) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const text = await response.text();
      if (text.length < 200) return;
      // Heuristic: a search-results JSON will contain product-shaped data —
      // a name/price tuple plus our search term ("milk") somewhere.
      if (/milk/i.test(text) && /price|pricing|\$/i.test(text) && /name/i.test(text)) {
        candidates.push({ url, sample: text.slice(0, 300) });
      }
    } catch { /* response stream not capturable — ignore */ }
  };
  page.on('response', onResp);
  try {
    await page.goto('https://www.coles.com.au/search/products?q=milk', { waitUntil: 'networkidle2', timeout: 25000 });
  } catch { /* navigation might time out but the responses are usually in by then */ }
  await wait(2500);
  page.off('response', onResp);

  // Prefer URLs that look like product search endpoints (mention 'search' or 'product')
  candidates.sort((a, b) => {
    const score = (u) => (u.includes('search') ? 2 : 0) + (u.includes('product') ? 2 : 0) + (u.includes('graphql') ? 1 : 0);
    return score(b.url) - score(a.url);
  });

  if (candidates.length === 0) {
    console.log('  No Coles JSON search endpoint discovered — falling back to DOM scrape.');
    return null;
  }

  console.log(`  Found ${candidates.length} candidate(s). Top: ${candidates[0].url.slice(0, 90)}…`);
  // Extract the query-template by replacing "milk" with a placeholder
  const tpl = candidates[0].url.replace(/([?&]q=)milk/i, '$1{Q}').replace(/(query=)milk/i, '$1{Q}');
  return tpl;
}

async function colesSearchViaApi(page, term, urlTemplate) {
  return page.evaluate(async (q, tpl) => {
    try {
      const url = tpl.replace('{Q}', encodeURIComponent(q));
      const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      // Coles internal shape varies; defensively extract a list with
      // {name, price[, unit]} from common locations.
      const extractList = (d) => {
        const candidates = [d?.results, d?.products, d?.items,
          d?.pageProps?.searchResults?.results,
          d?.data?.search?.products,
          d?.data?.searchProducts?.results,
        ].filter(Array.isArray);
        return candidates[0] || [];
      };
      const list = extractList(data);
      return list.map(p => ({
        name: p?.name || p?.productName || p?.title || '?',
        price: typeof p?.pricing?.now === 'number' ? p.pricing.now
              : typeof p?.pricing?.normal === 'number' ? p.pricing.normal
              : typeof p?.price === 'number' ? p.price
              : null,
        cup: p?.pricing?.unit?.value ? `${p.pricing.unit.value} ${p.pricing.unit.unit ?? ''}`.trim()
            : p?.unitPrice || '',
      })).filter(x => typeof x.price === 'number');
    } catch { return null; }
  }, term, urlTemplate);
}

async function colesSearchViaDom(page, term) {
  try {
    await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(term)}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
  } catch { return []; }
  try {
    await page.waitForSelector('[data-testid="product-tile"]', { timeout: 8000 });
  } catch { /* tiles never appeared — likely a captcha or zero results */ }
  await wait(800);
  return page.evaluate(() => {
    const tiles = document.querySelectorAll('[data-testid="product-tile"]');
    const out = [];
    for (const tile of tiles) {
      const titleEl = tile.querySelector('[data-testid="product-title"], h2, h3');
      const priceEl = tile.querySelector('[data-testid="product-pricing"] .price__value, .price__value');
      const unitEl  = tile.querySelector('.price__calculation_method, [data-testid="product-pricing-unit"]');
      if (!titleEl || !priceEl) continue;
      const name = titleEl.textContent.trim();
      const m = priceEl.textContent.match(/\$(\d+\.\d{2})/);
      if (!m || !name) continue;
      out.push({ name, price: parseFloat(m[1]), cup: unitEl?.textContent?.trim() || '' });
    }
    return out;
  });
}

async function colesBest(page, term) {
  if (colesApiPattern) {
    const list = await colesSearchViaApi(page, term, colesApiPattern);
    if (list && list.length) return list;
    // API returned nothing for this query — fall back to DOM for this one item
  }
  return colesSearchViaDom(page, term);
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

  // One-shot discovery of Coles' internal search endpoint — saves us a
  // full page navigation per query. Falls back to DOM scrape if discovery
  // doesn't find anything.
  colesApiPattern = await discoverColesApi(cPage);
  console.log(colesApiPattern
    ? `  Coles via internal API: ${colesApiPattern.slice(0, 80)}…`
    : `  Coles via DOM scrape (slower fallback).`);

  const ts = new Date().toISOString();
  const records = [];

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
      const ws = await woolworthsBest(wPage, t);
      if (Array.isArray(ws)) wAll.push(...ws);
      const cs = await colesBest(cPage, t);
      if (Array.isArray(cs)) cAll.push(...cs);
      // Stop early if we have enough candidates
      if (wAll.length > 8 && cAll.length > 8) break;
      await wait(150);
    }

    // Confirm products by attribute (size/pack/unit). Soft floor of $0.10
    // catches obvious data errors (negative price, scraping artefact, etc.)
    const confirmed = (p) =>
      typeof p.price === 'number' && p.price >= 0.10
      && productMatches(item.name, p.name, p.cup);

    const wValid = wAll.filter(confirmed).sort((a, b) => a.price - b.price);
    const cValid = cAll.filter(confirmed).sort((a, b) => a.price - b.price);
    const wBest = wValid[0] || null;
    const cBest = cValid[0] || null;

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
      ...(wReject ? { _rejected_w: { name: wReject.name, price: wReject.price } } : {}),
      ...(cReject ? { _rejected_c: { name: cReject.name, price: cReject.price } } : {}),
    };
    appendPrice(rec);
    records.push({ item, current: { woolworths: wBest, coles: cBest } });

    const wDisplay = wBest ? `$${wBest.price.toFixed(2)}` : (wAll.length ? `?(${wAll.length})` : '-');
    const cDisplay = cBest ? `$${cBest.price.toFixed(2)}` : (cAll.length ? `?(${cAll.length})` : '-');
    process.stdout.write(`  ${item.name.padEnd(45).slice(0, 45)}  W: ${wDisplay.padStart(8)}  C: ${cDisplay.padStart(8)}\n`);
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
