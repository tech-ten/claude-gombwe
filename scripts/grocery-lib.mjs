/**
 * GROCERY LIB — shared primitives for grocery-buy.mjs (production buy flow)
 * and grocery-watch.mjs (daily price watcher / deal detector).
 *
 * Extracted from the existing grocery-buy.mjs implementation (which was
 * already mature) plus the new attribute-based matcher and Coles internal-
 * API discovery added during the watch-build pass.
 *
 * Exports:
 *   Constants:   PORT, PROFILE_DIR, GOMBWE_PORT_ENV,
 *                MIN_ORDER_WOOLWORTHS, MIN_ORDER_COLES
 *   Utilities:   wait
 *   Chrome:      connectChrome, clearBrowserCache, getPage
 *   Auth:        notifyGombwe, looksLikeLoginWall, assertLoggedIn
 *   Search:      woolworthsSearch, discoverColesApi, colesSearch
 *   Matching:    normaliseName, extractTokens, productMatches,
 *                pickBestProduct
 *
 * Behavioural rule: NOTHING in this file should change behaviour for an
 * existing call-site in grocery-buy.mjs. If you need a new option, add it
 * with a safe default. Both consumers must keep working.
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { findChrome, detachedSpawnOptions } from './platform.mjs';

// ── constants ────────────────────────────────────────────────────────

export const PORT                  = 19222;
export const PROFILE_DIR           = join(homedir(), '.claude-gombwe', 'chrome-profile');
export const GOMBWE_PORT_ENV       = process.env.GOMBWE_PORT || '18790';
export const MIN_ORDER_WOOLWORTHS  = 75;
export const MIN_ORDER_COLES       = 50;

export const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Chrome plumbing ──────────────────────────────────────────────────

export async function connectChrome() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {}

  if (!existsSync(PROFILE_DIR)) {
    console.error('No saved login. Run: gombwe grocery-setup');
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }

  spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.woolworths.com.au',
    'https://www.coles.com.au',
  ], detachedSpawnOptions()).unref();

  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch {}
  }
  console.error('Chrome failed to start.'); process.exit(1);
}

export async function clearBrowserCache(browser, enabled = true) {
  if (!enabled) return;
  console.log('  Clearing browser cache...');
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCache');
    // NOTE: Do NOT clear cookies — that logs us out of Woolworths/Coles
    // and breaks all authenticated API calls (cart, checkout, payment).
    await client.detach();
    console.log('  Cache cleared.');
  } catch (err) {
    console.log(`  Cache clear failed (${err.message}) — continuing anyway.`);
  }
}

export async function getPage(browser, domain) {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes(domain));
  if (!page) {
    page = await browser.newPage();
    await page.goto(`https://www.${domain}`, { waitUntil: 'networkidle2', timeout: 15000 });
    await wait(3000);
  }
  return page;
}

// ── Auth + alerting ──────────────────────────────────────────────────

/** Best-effort POST to gombwe's /api/notify (Discord/Telegram/web fan-out).
 *  Silent if gombwe isn't running — log only. */
export async function notifyGombwe(message) {
  try {
    const res = await fetch(`http://127.0.0.1:${GOMBWE_PORT_ENV}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) console.warn(`  notify endpoint returned ${res.status}`);
  } catch (err) {
    console.warn(`  (couldn't reach gombwe to notify: ${err.message})`);
  }
}

/** Conservative URL-only check — only the strong logged-out signals. */
export function looksLikeLoginWall(page) {
  const url = page.url().toLowerCase();
  if (url.includes('/login')) return true;
  if (url.includes('/sign-in') || url.includes('/signin')) return true;
  if (url.includes('/auth/')) return true;
  if (url.includes('account.woolworths') || url.includes('account/sign-in')) return true;
  if (url.includes('coles.com.au/login')) return true;
  return false;
}

/** Definitive auth test: navigate to /cart — both retailers redirect
 *  unauthenticated users to login. Fires a gombwe alert and exits with
 *  code 2 if the session is dead. */
export async function assertLoggedIn(page, store) {
  const cartUrl = store === 'woolworths'
    ? 'https://www.woolworths.com.au/shop/cart'
    : 'https://www.coles.com.au/cart';
  try {
    await page.goto(cartUrl, { waitUntil: 'networkidle2', timeout: 12000 });
  } catch { /* navigation timeout still tells us via final URL */ }

  if (looksLikeLoginWall(page)) {
    const msg = [
      `⚠️  gombwe grocery: ${store} session expired`,
      ``,
      `The cron / skill couldn't add items because the saved Chrome profile is no longer logged in to ${store}.com.au.`,
      `Run \`gombwe grocery-setup\` (or open the gombwe Chrome profile manually) and sign in again — cookies will refresh for ~60 days.`,
      `URL after /cart redirect: ${page.url()}`,
    ].join('\n');
    console.error(`\n  LOGIN WALL detected at ${page.url()}`);
    console.error(`  Aborting — no items added.\n`);
    await notifyGombwe(msg);
    process.exit(2);
  }
}

// ── Search ───────────────────────────────────────────────────────────

/** Woolworths exposes a clean JSON search API — preferred path.
 *  Returns up to `limit` candidate products as
 *  {name, price, stockcode, url, cup}. Empty array on failure.
 *  `cup` is the unit-price string (e.g. "$3.55 / Per 2L"). */
export async function woolworthsSearch(page, query, limit = 10) {
  const response = await page.evaluate(async (q, pageSize) => {
    try {
      const res = await fetch(
        `https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageSize=${pageSize}`,
        { headers: { 'Accept': 'application/json' } },
      );
      return await res.json();
    } catch { return null; }
  }, query, limit);

  const products = [];
  if (response?.Products) {
    for (const group of response.Products) {
      for (const p of (group.Products || [group])) {
        if (!p.Stockcode) continue;
        products.push({
          name:      p.DisplayName || p.Name || '',
          price:     typeof p.Price === 'number' ? p.Price
                    : typeof p.InstorePrice === 'number' ? p.InstorePrice
                    : null,
          stockcode: p.Stockcode,
          url:       `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}`,
          cup:       p.CupString || '',
        });
      }
    }
  }
  return products.slice(0, limit);
}

/** Discover Coles's internal SPA search endpoint by sniffing the response
 *  stream during one search. Returns a URL template with `{Q}` placeholder
 *  for the query, or null if discovery doesn't find anything (caller falls
 *  back to DOM scrape). */
export async function discoverColesApi(page) {
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
      if (/milk/i.test(text) && /price|pricing|\$/i.test(text) && /name/i.test(text)) {
        candidates.push({ url });
      }
    } catch { /* response stream not capturable */ }
  };
  page.on('response', onResp);
  try {
    await page.goto('https://www.coles.com.au/search/products?q=milk', { waitUntil: 'networkidle2', timeout: 25000 });
  } catch { /* nav timeout still leaves responses captured */ }
  await wait(2500);
  page.off('response', onResp);

  candidates.sort((a, b) => {
    const score = (u) => (u.includes('search') ? 2 : 0) + (u.includes('product') ? 2 : 0) + (u.includes('graphql') ? 1 : 0);
    return score(b.url) - score(a.url);
  });

  if (candidates.length === 0) {
    console.log('  No Coles JSON search endpoint discovered — falling back to DOM scrape.');
    return null;
  }

  const tpl = candidates[0].url.replace(/([?&]q=)milk/i, '$1{Q}').replace(/(query=)milk/i, '$1{Q}');
  console.log(`  Coles via internal API: ${tpl.slice(0, 100)}${tpl.length > 100 ? '…' : ''}`);
  return tpl;
}

/** Search Coles. Tries the discovered JSON API first, falls back to DOM
 *  scrape. Returns array of {name, price, url, cup}. Pass `apiPattern`
 *  from discoverColesApi() to enable fast path; null = DOM only. */
export async function colesSearch(page, query, apiPattern = null) {
  if (apiPattern) {
    const list = await page.evaluate(async (q, tpl) => {
      try {
        const url = tpl.replace('{Q}', encodeURIComponent(q));
        const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json();
        const extractList = (d) => {
          const lists = [
            d?.results, d?.products, d?.items,
            d?.pageProps?.searchResults?.results,
            d?.data?.search?.products,
            d?.data?.searchProducts?.results,
          ].filter(Array.isArray);
          return lists[0] || [];
        };
        const items = extractList(data);
        return items.map(p => ({
          name:  p?.name || p?.productName || p?.title || '',
          price: typeof p?.pricing?.now === 'number' ? p.pricing.now
                : typeof p?.pricing?.normal === 'number' ? p.pricing.normal
                : typeof p?.price === 'number' ? p.price
                : null,
          url:   p?.url || p?.canonicalUrl || null,
          cup:   p?.pricing?.unit?.value ? `${p.pricing.unit.value} ${p.pricing.unit.unit ?? ''}`.trim()
                : p?.unitPrice || '',
        })).filter(x => typeof x.price === 'number');
      } catch { return null; }
    }, query, apiPattern);
    if (list && list.length) return list;
    // API returned nothing — fall through to DOM for this one query
  }

  // DOM-scrape fallback (works without discovery)
  try {
    await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
  } catch { return []; }
  try {
    await page.waitForSelector('[data-testid="product-tile"]', { timeout: 8000 });
  } catch { /* tiles never appeared — captcha or zero results */ }
  await wait(800);
  return page.evaluate(() => {
    const tiles = document.querySelectorAll('[data-testid="product-tile"], section');
    const out = [];
    for (const tile of tiles) {
      const titleEl = tile.querySelector('[data-testid="product-title"], h2, h3');
      const priceEl = tile.querySelector('[data-testid="product-pricing"] .price__value, .price__value');
      const unitEl  = tile.querySelector('.price__calculation_method, [data-testid="product-pricing-unit"]');
      if (!titleEl || !priceEl) continue;
      const name = titleEl.textContent.trim();
      if (!name || name.length < 3) continue;
      const m = priceEl.textContent.match(/\$(\d+\.\d{2})/);
      if (!m) continue;
      const linkEl = tile.querySelector('a[href*="/product/"]');
      out.push({
        name,
        price: parseFloat(m[1]),
        url: linkEl?.href || null,
        cup: unitEl?.textContent?.trim() || '',
      });
    }
    return out;
  });
}

// ── Matching ─────────────────────────────────────────────────────────

export function normaliseName(s) {
  return String(s || '').toLowerCase()
    .replace(/[-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words to ignore when looking for name-overlap between watchlist and
// candidate. Units, pack-count nouns, and prepositions never identify a
// product on their own — "per kg" alone matches everything sold by weight.
const NAME_STOPWORDS = new Set([
  'the','and','or','of','for','with','a','an','in','on','to','per','each',
  'pack','packs','pk','kg','g','ml','l','cl','tab','tabs','tablet','tablets',
  'capsule','capsules','caps','count','ct','approx',
]);

export function significantWords(s) {
  return normaliseName(s).split(/\s+/).filter(w =>
    w.length >= 3
    && !NAME_STOPWORDS.has(w)
    && !/^\d+(?:\.\d+)?$/.test(w)
    && !/^\d+(?:\.\d+)?[a-z]+$/.test(w)
  );
}

export function extractTokens(itemName) {
  const norm = normaliseName(itemName);
  const tokens = { sizes: [], pack: null, perKg: false, each: false };
  const sizeRe = /(\d+(?:\.\d+)?)\s?(l|ml|g|kg|cl)\b/g;
  let m;
  while ((m = sizeRe.exec(norm)) !== null) tokens.sizes.push(`${m[1]}${m[2]}`);
  // Watchlist items routinely say "38 tabs" not "38 pack" — extend the
  // suffix list so the matcher picks up a real pack-count constraint.
  const pm = norm.match(/(\d+)\s?(pack|pk|tabs?|tablets?|capsules?|caps)\b/);
  if (pm) tokens.pack = parseInt(pm[1], 10);
  if (/\bper\s+kg\b/.test(norm)) tokens.perKg = true;
  if (/\beach\b/.test(norm)) tokens.each = true;
  return tokens;
}

/** Confirm a returned product is a real match for our watchlist/search
 *  entry. Attribute match, NOT price band. Returns the rejection reason
 *  for diagnostic use (calibrator); the boolean wrapper below is what
 *  most callers want. */
export function productMatchesDetailed(watchlistName, productName, unitString = '') {
  const want = extractTokens(watchlistName);
  const got = normaliseName(productName);
  const unit = normaliseName(unitString);

  // Name-overlap gate — at least one distinctive watchlist word must
  // appear in the candidate. (Observed: "Oxyshred" pre-workout matched
  // against "Finish Quantum Ultimate 38 tabs" before this gate existed.)
  const wantWords = significantWords(watchlistName);
  if (wantWords.length > 0) {
    const gotWords = new Set(got.split(/\s+/));
    if (!wantWords.some(w => gotWords.has(w))) {
      return { ok: false, reason: `no-name-overlap (need any of: ${wantWords.slice(0, 3).join(', ')})` };
    }
  }

  for (const s of want.sizes) {
    const num = s.replace(/[a-z]/g, '');
    const u = s.replace(/[\d.]/g, '');
    const altLitres = u === 'l' ? `${num} litre` : null;
    if (!got.includes(s)
        && !got.includes(`${num} ${u}`)
        && !(altLitres && got.includes(altLitres))) {
      return { ok: false, reason: `size-mismatch (need ${s})` };
    }
  }
  if (want.pack !== null) {
    const packRe = new RegExp(`\\b${want.pack}\\s?(pack|pk|tabs?|tablets?|capsules?|caps)\\b`);
    if (!packRe.test(got)) {
      return { ok: false, reason: `pack-mismatch (need ${want.pack}-pack)` };
    }
  }
  if (want.perKg) {
    // Unit-string "$X / 1kg" is a per-kg COMPARISON price, not proof the
    // product is sold per kg — an 80g pack also shows it. Reject names
    // that state a smaller g/ml pack and require the name to mention kg.
    if (/\b\d+(?:\.\d+)?\s?(g|ml)\b/.test(got)) {
      return { ok: false, reason: 'has-small-pack (g/ml in name, need per kg)' };
    }
    // "kg\b" — covers "per kg" / "1kg" / "1.1kg" / "approx. 1.1kg".
    // No leading \b: the digit→letter transition in "1.1kg" isn't a
    // non-word boundary.
    if (!/kg\b/.test(got)) {
      return { ok: false, reason: 'not-per-kg (name has no kg)' };
    }
  }
  if (want.each && !want.perKg) {
    if (!/\beach\b/.test(got) && !/\beach\b/.test(unit)) {
      return { ok: false, reason: 'not-sold-each' };
    }
  }
  return { ok: true, reason: null };
}

export function productMatches(watchlistName, productName, unitString = '') {
  return productMatchesDetailed(watchlistName, productName, unitString).ok;
}

/** Pick the best product from a search-result list.
 *
 *  Supports both call patterns for back-compatibility:
 *    pickBestProduct(products, "milk 2L")                  ← legacy: searchTerm only
 *    pickBestProduct(products, { searchTerm, priceLimits, priceBuffer, requireMatch })
 *
 *  Options:
 *    searchTerm    — the query (used for price-limit fuzzy lookup)
 *    priceLimits   — dict from prefs.price_limits (per-keyword ceilings)
 *    priceBuffer   — multiplier above price_limits before warning (default 1.15)
 *    requireMatch  — optional (product) => bool; if provided, products that
 *                    fail this are filtered out BEFORE picking
 *
 *  Behaviour for the buy script's existing call sites is preserved exactly
 *  when called with the legacy positional searchTerm.
 */
export function pickBestProduct(products, optsOrTerm = {}) {
  if (!products || products.length === 0) return null;

  const opts = typeof optsOrTerm === 'string' ? { searchTerm: optsOrTerm } : (optsOrTerm || {});
  const { searchTerm = '', priceLimits = null, priceBuffer = 1.15, requireMatch = null } = opts;

  // Optional pre-filter by attribute match
  let candidates = products;
  if (requireMatch) candidates = products.filter(p => requireMatch(p));
  if (candidates.length === 0) return null;

  // Find the applicable price limit (fuzzy match on search term)
  let limit = null;
  if (priceLimits && searchTerm) {
    const termLower = searchTerm.toLowerCase();
    for (const [key, val] of Object.entries(priceLimits)) {
      const k = key.toLowerCase();
      if (termLower.includes(k) || k.includes(termLower.split(' ')[0])) {
        limit = val * priceBuffer;
        break;
      }
    }
  }

  // Sort by price ascending — null/999 treated as expensive
  const sorted = [...candidates].sort((a, b) => (a.price || 999) - (b.price || 999));

  if (limit) {
    const underLimit = sorted.find(p => p.price && p.price <= limit);
    if (underLimit) return underLimit;
    const cheapest = sorted[0];
    console.log(`  ⚠ PRICE WARNING: "${searchTerm}" cheapest is $${cheapest.price?.toFixed(2)} (limit ~$${limit.toFixed(2)})`);
    return cheapest;
  }

  return sorted[0];
}
