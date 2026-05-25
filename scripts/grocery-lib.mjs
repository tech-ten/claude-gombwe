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
import { logSearch, logDiscoveryAttempt } from './grocery-forensics.mjs';

// ── constants ────────────────────────────────────────────────────────

export const PORT                  = 19222;
export const PROFILE_DIR           = join(homedir(), '.claude-gombwe', 'chrome-profile');
export const GOMBWE_PORT_ENV       = process.env.GOMBWE_PORT || '18790';
export const MIN_ORDER_WOOLWORTHS  = 75;
export const MIN_ORDER_COLES       = 50;

export const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Sleep for a random duration in [min, max] ms — used between scraper
 *  requests to make request patterns less mechanical / fingerprintable. */
export const jitter = (min = 200, max = 800) =>
  new Promise(r => setTimeout(r, min + Math.floor(Math.random() * (max - min + 1))));

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
  const _t0 = Date.now();
  if (response?.Products) {
    let position = 0;
    for (const group of response.Products) {
      for (const p of (group.Products || [group])) {
        if (!p.Stockcode) continue;
        position++;
        // Aggressive field extraction — the API returns 40+ fields per
        // product and we want them all for the long-term dataset.
        // Unknown future fields land in `_raw` for forensic safety.
        products.push({
          name:         p.DisplayName || p.Name || '',
          price:        typeof p.Price === 'number' ? p.Price
                       : typeof p.InstorePrice === 'number' ? p.InstorePrice
                       : null,
          product_id:   String(p.Stockcode),
          stockcode:    p.Stockcode,
          url:          `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}`,
          cup:          p.CupString || '',
          // Promos / specials
          was_price:    typeof p.WasPrice === 'number' ? p.WasPrice : null,
          is_on_special:!!p.IsOnSpecial,
          save_amount:  typeof p.SavingsAmount === 'number' ? p.SavingsAmount : null,
          promotion:    p.Promotion || p.PromotionInfo || null,
          // Identity / classification
          brand:        p.Brand || null,
          variety:      p.Variety || null,
          package_size: p.PackageSize || null,
          unit_of_size: p.UnitOfSize || null,
          barcode:      p.Barcode || null,
          department:   p.Department || null,
          category:     p.Category || null,
          sap_dept:     p.SapDepartmentName || null,
          sap_aisle:    p.SapAisleName || null,
          // Media / description
          image_url:    p.LargeImageFile || p.MediumImageFile || p.SmallImageFile || null,
          description:  p.Description || null,
          // Availability / restrictions
          in_stock:     p.IsAvailable !== false,
          is_available: p.IsAvailable !== false,
          age_restricted:!!p.AgeRestricted,
          // Search-result context
          search_position: position,
          is_sponsored: !!(p.AdId || p.AdvertId || p.IsAdvertisement),
          ad_id:        p.AdId || p.AdvertId || null,
          // Ratings
          rating:       typeof p.AverageRating === 'number' ? p.AverageRating : null,
          rating_count: typeof p.RatingCount === 'number' ? p.RatingCount : null,
          // Diet / additional attributes (keep as-is, structure varies)
          additional_attributes: Array.isArray(p.AdditionalAttributes) ? p.AdditionalAttributes : null,
          // Full forensic blob — preserves anything we missed above.
          _raw: p,
        });
      }
    }
  }
  const out = products.slice(0, limit);
  logSearch({ store: 'woolworths', query, result_count: out.length, ms: Date.now() - _t0, ok: out.length > 0 });
  return out;
}

/** Discover Coles's internal SPA search endpoint. Tries the cached pattern
 *  first (fast, no network noise); falls back to sniffing the response stream
 *  during one search if no cached pattern validates. Returns a URL template
 *  with `{Q}` placeholder for the query, or null if discovery fails entirely
 *  (caller falls back to DOM scrape). */
export async function discoverColesApi(page) {
  // Lazy import keeps grocery-lib loadable without the cache module
  // present (e.g. older deploys, test fixtures).
  const { tryCachedApiPattern, recordSuccessfulPattern } = await import('./grocery-api-cache.mjs');

  // 1. Cheap path — try previously-validated patterns first.
  // Saves ~25s and avoids the noisy load-search-page-and-sniff signature.
  const cached = await tryCachedApiPattern(page);
  if (cached) {
    console.log(`  Coles via cached API pattern: ${cached.slice(0, 80)}${cached.length > 80 ? '…' : ''}`);
    return cached;
  }

  console.log('  Discovering Coles internal search endpoint (network sniff)…');
  const candidates = [];
  // Also collect ALL JSON responses we saw, not just the ones that
  // passed our content filter — explains discovery failures when they
  // happen ("we saw N JSON URLs but none matched the milk/price/name
  // pattern, here they are").
  const allJsonSeen = [];
  const onResp = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('coles.com.au')) return;
      if (response.status() !== 200) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const text = await response.text();
      if (text.length < 200) return;
      allJsonSeen.push({ url, bytes: text.length, has_milk: /milk/i.test(text), has_price: /price|pricing|\$/i.test(text), has_name: /name/i.test(text) });
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
    console.log(`  No Coles JSON search endpoint discovered (${allJsonSeen.length} JSON URLs sniffed but none matched filter) — falling back to DOM scrape.`);
    logDiscoveryAttempt({ captured_urls: allJsonSeen, picked_template: null, success: false });
    return null;
  }

  const tpl = candidates[0].url.replace(/([?&]q=)milk/i, '$1{Q}').replace(/(query=)milk/i, '$1{Q}');
  console.log(`  Coles via internal API (newly discovered): ${tpl.slice(0, 80)}${tpl.length > 80 ? '…' : ''}`);
  recordSuccessfulPattern(tpl);
  logDiscoveryAttempt({ captured_urls: allJsonSeen, picked_template: tpl, success: true });
  return tpl;
}

/** Search Coles via __NEXT_DATA__ — the SSR data blob Coles embeds on
 *  every search page. Contains every result with full structured data
 *  (id, name, brand, size, pricing.now, pricing.was, unit price, ad
 *  flags, category hierarchy, stock quantity, retail/promo limits).
 *  No API discovery, no XHR sniffing, no DOM scraping. Just navigate
 *  to the search URL and parse the <script id="__NEXT_DATA__"> tag.
 *  Returns array in our standard candidate shape, or empty on failure. */
export async function colesSearchViaNextData(page, query) {
  try {
    await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
  } catch { return []; }
  return page.evaluate(() => {
    const nd = document.querySelector('#__NEXT_DATA__');
    if (!nd) return [];
    let data;
    try { data = JSON.parse(nd.textContent); } catch { return []; }
    const results = data?.props?.pageProps?.searchResults?.results || [];
    const out = [];
    let position = 0;
    for (const p of results) {
      if (p?._type !== 'PRODUCT' || !p?.id) continue;
      position++;
      const pricing = p.pricing || {};
      const unit = pricing.unit || {};
      const imageRel = p.imageUris?.[0]?.uri || null;
      // Coles image CDN — uri is like "/9/9760091.jpg"
      const imageUrl = imageRel
        ? `https://cdn.productimages.coles.com.au/productimages${imageRel}`
        : null;
      out.push({
        name: p.name || '',
        price: typeof pricing.now === 'number' ? pricing.now : null,
        product_id: String(p.id),
        url: `https://www.coles.com.au/product/${p.id}`,
        cup: pricing.comparable || (unit.price && unit.ofMeasureType
              ? `\$${unit.price}/ ${unit.ofMeasureQuantity || 1}${unit.ofMeasureType}` : ''),
        // Promo
        was_price:     typeof pricing.was === 'number' && pricing.was > 0 ? pricing.was : null,
        is_on_special: !!pricing.onlineSpecial || (typeof pricing.was === 'number' && pricing.was > 0 && pricing.was > pricing.now),
        save_amount:   (typeof pricing.was === 'number' && pricing.was > 0)
                       ? +(pricing.was - pricing.now).toFixed(2) : null,
        promotion:     pricing.promotion || null,
        promotion_text:pricing.promotionDescription || null,
        // Identity
        brand:         p.brand || null,
        size:          p.size || null,
        package_size:  p.size || null,
        description:   p.description || null,
        // Category — Coles has TWO hierarchies; capture both
        merchandise_hier: p.merchandiseHeir ? `${p.merchandiseHeir.category} / ${p.merchandiseHeir.subCategory} / ${p.merchandiseHeir.className}` : null,
        category:      p.onlineHeirs?.[0]?.category || null,
        department:    p.merchandiseHeir?.tradeProfitCentre || null,
        // Media
        image_url:     imageUrl,
        // Availability + restrictions
        in_stock:      p.availability !== false,
        is_available:  p.availability !== false,
        available_quantity: typeof p.availableQuantity === 'number' ? p.availableQuantity : null,
        availability_type: p.availabilityType || null,
        age_restricted:!!(p.restrictions?.liquorAgeRestrictionFlag || p.restrictions?.tobaccoAgeRestrictionFlag),
        restrictions:  p.restrictions || null,
        retail_limit:  typeof p.restrictions?.retailLimit === 'number' ? p.restrictions.retailLimit : null,
        promo_limit:   typeof p.restrictions?.promotionalLimit === 'number' ? p.restrictions.promotionalLimit : null,
        min_shelf_life: p.minGuarantee || null,
        // Search context
        search_position: position,
        is_sponsored: !!(p.adId || p.adSource || p.featured),
        sponsored_marker: p.adId ? `adId=${p.adId}` : (p.featured ? 'featured' : (p.adSource ? `adSource=${p.adSource}` : null)),
        ad_id:        p.adId || null,
        ad_source:    p.adSource || null,
        // Variations
        variation_count: typeof p.variations?.total === 'number' ? p.variations.total : null,
        _source:      'nextdata',
        _raw:         p,
      });
    }
    return out;
  });
}

/** Search Coles. Strategy order:
 *  1. __NEXT_DATA__ (preferred — full structured data, no detection signal)
 *  2. Discovered JSON API (legacy fallback if NEXT_DATA shape changes)
 *  3. DOM-scrape fallback
 *  Returns array in our standard candidate shape. */
export async function colesSearch(page, query, apiPattern = null) {
  const _t0 = Date.now();

  // 1. __NEXT_DATA__ — the data is right there in the HTML, no XHR needed.
  try {
    const list = await colesSearchViaNextData(page, query);
    if (list && list.length) {
      logSearch({ store: 'coles', query, result_count: list.length, ms: Date.now() - _t0, ok: true });
      return list;
    }
  } catch { /* fall through */ }

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
        const extractId = (p) => {
          // Try direct fields first; fall back to URL slug parsing.
          if (p?.id) return String(p.id);
          if (p?.productId) return String(p.productId);
          if (p?.code) return String(p.code);
          const url = p?.url || p?.canonicalUrl || '';
          const m = url.match(/-(\d{4,})(?:[/?#].*)?$/);
          return m ? m[1] : null;
        };
        return items.map((p, idx) => ({
          name:  p?.name || p?.productName || p?.title || '',
          price: typeof p?.pricing?.now === 'number' ? p.pricing.now
                : typeof p?.pricing?.normal === 'number' ? p.pricing.normal
                : typeof p?.price === 'number' ? p.price
                : null,
          product_id: extractId(p),
          url:   p?.url || p?.canonicalUrl || null,
          cup:   p?.pricing?.unit?.value ? `${p.pricing.unit.value} ${p.pricing.unit.unit ?? ''}`.trim()
                : p?.unitPrice || '',
          // Promos / specials
          was_price:        typeof p?.pricing?.was === 'number' ? p.pricing.was
                          : typeof p?.pricing?.normal === 'number' ? p.pricing.normal
                          : null,
          is_on_special:    !!(p?.pricing?.onSpecial || p?.pricing?.saveAmount),
          save_amount:      typeof p?.pricing?.saveAmount === 'number' ? p.pricing.saveAmount : null,
          promotion:        p?.pricing?.promotion || p?.pricing?.promotionType || null,
          promotion_text:   p?.pricing?.promotionDescription || p?.pricing?.offerText || null,
          // Identity / classification
          brand:            p?.brand?.name || p?.brand || null,
          size:             p?.size || p?.packSize || null,
          merchandise_hier: p?.merchandiseHeir || p?.merchandiseHierarchy || null,
          category:         p?.category?.name || p?.categoryName || null,
          // Media / description
          image_url:        p?.imageUris?.large || p?.imageUris?.medium || p?.imageUris?.small
                          || p?.image?.url || p?.imageUrl || null,
          description:      p?.description || null,
          // Availability / restrictions
          in_stock:         p?.availability?.status !== 'NotAvailable' && p?.availability?.inStock !== false,
          restrictions:     p?.restrictions || null,
          // Search-result context
          search_position:  idx + 1,
          is_sponsored:     !!(p?.adId || p?.adType || p?.sponsored),
          ad_id:            p?.adId || null,
          ad_type:          p?.adType || null,
          // Ratings
          rating:           typeof p?.rating?.average === 'number' ? p.rating.average : null,
          rating_count:     typeof p?.rating?.count === 'number' ? p.rating.count : null,
          // Full forensic blob — preserves anything we missed.
          _raw: p,
        })).filter(x => typeof x.price === 'number');
      } catch { return null; }
    }, query, apiPattern);
    if (list && list.length) {
      logSearch({ store: 'coles', query, result_count: list.length, ms: Date.now() - _t0, ok: true });
      return list;
    }
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
  const domResult = await page.evaluate(() => {
    const tiles = document.querySelectorAll('[data-testid="product-tile"], section');
    const out = [];
    let position = 0;
    for (const tile of tiles) {
      const titleEl = tile.querySelector('[data-testid="product-title"], h2.product__title, h2, h3');
      const priceEl = tile.querySelector('[data-testid="product-pricing"], .price__value');
      const unitEl  = tile.querySelector('.price__calculation_method, [data-testid="product-pricing-unit"]');
      if (!titleEl || !priceEl) continue;
      const fullTitle = titleEl.textContent.trim();
      if (!fullTitle || fullTitle.length < 3) continue;
      // Cleaner: aria-label is "Price $25.00" or "Price $1.50" — avoids
      // partial DOM text leaks like "$25.00 Save $3.00".
      const ariaPrice = priceEl.getAttribute('aria-label')?.match(/\$([\d.]+)/);
      const textPrice = priceEl.textContent.match(/\$(\d+\.\d{2})/);
      const priceMatch = ariaPrice || textPrice;
      if (!priceMatch) continue;
      position++;

      // Coles titles use " | " as a name/size separator:
      //   "Finish Quantum Dishwashing Tablets Lemon | 60 Pack"
      // Split so the package_size becomes queryable on its own.
      let cleanName = fullTitle, packageSize = null;
      const sepIdx = fullTitle.lastIndexOf(' | ');
      if (sepIdx > 0) {
        cleanName  = fullTitle.slice(0, sepIdx).trim();
        packageSize = fullTitle.slice(sepIdx + 3).trim();
      }

      const linkEl    = tile.querySelector('a[href*="/product/"]');
      const hrefStr   = linkEl?.getAttribute('href') || '';
      const idMatch   = hrefStr.match(/-(\d{4,})(?:[/?#].*)?$/);
      const productId = idMatch ? idMatch[1] : null;
      const wasEl     = tile.querySelector('.price__was, [data-testid="product-pricing-was"]');
      const saveEl    = tile.querySelector('.badge-label, .price__save, [data-testid="product-pricing-save"]');
      const specialEl = tile.querySelector(
        '[data-testid="simple-fixed-price-specials"], [data-testid*="special"], [data-testid*="promotion"], .product__badge'
      );
      const multibuyEl = tile.querySelector('[data-testid*="multibuy"], [class*="multibuy"], [data-testid*="multi-buy"]');
      const imgEl     = tile.querySelector('img[data-testid="product-image"], img');
      // Broader sponsored/promoted/featured detection. Coles labels
      // these inconsistently across tile templates; cast a wider net
      // (case-insensitive via i flag in attribute selectors).
      const sponsoredEl = tile.querySelector(
        '[data-testid*="sponsored" i], [data-testid*="promoted" i], [data-testid*="featured" i], '
      + '[data-testid*="advertis" i], [data-testid*="ad-" i], [data-testid="adInfo"], '
      + '[class*="sponsored" i], [class*="Sponsored"], [class*="promoted" i], '
      + '[class*="advertis" i], [class*="adContent" i], [class*="AdBadge" i], '
      + '[aria-label*="sponsored" i], [aria-label*="advertisement" i], '
      + '[role="complementary"]'
      );
      // Also look for tile-level text labels (some templates use a plain
      // text "Sponsored" span without a stable selector).
      const sponsoredByText = !sponsoredEl && /\b(sponsored|advertisement|advertised|promoted)\b/i.test(tile.textContent || '');
      const restrictionEl = tile.querySelector('[data-testid*="restriction"], [data-testid*="age-"], [class*="age-restriction"]');
      const unavailableEl = tile.querySelector('[data-testid*="unavailable"], [class*="unavailable"], [data-testid*="out-of-stock"]');
      const limitEl   = tile.querySelector('[data-testid*="purchase-limit"], [class*="purchase-limit"]');
      const ratingEl  = tile.querySelector('[data-testid*="rating"], [class*="rating"]');
      const reviewEl  = tile.querySelector('[data-testid*="review-count"], [class*="review-count"]');

      const wasMatch  = wasEl?.textContent?.match(/\$(\d+(?:\.\d+)?)/);
      const saveMatch = saveEl?.textContent?.match(/\$(\d+(?:\.\d+)?)/);
      const ratingMatch = ratingEl?.getAttribute('aria-label')?.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/i);
      const reviewMatch = reviewEl?.textContent?.match(/(\d+)/);

      out.push({
        name: cleanName,
        price: parseFloat(priceMatch[1]),
        product_id: productId,
        url: linkEl ? new URL(linkEl.getAttribute('href'), 'https://www.coles.com.au').href : null,
        cup: unitEl?.textContent?.trim() || '',
        // Identity
        package_size: packageSize,
        // Promo
        was_price:     wasMatch ? parseFloat(wasMatch[1]) : null,
        save_amount:   saveMatch ? parseFloat(saveMatch[1]) : null,
        is_on_special: !!(wasEl || saveEl || specialEl),
        promotion_text: (specialEl?.textContent || '').replace(/\s+/g, ' ').trim() || null,
        is_multibuy:   !!multibuyEl,
        multibuy_text: multibuyEl?.textContent?.trim() || null,
        // Media
        image_url: imgEl?.src || null,
        // Availability / restrictions
        in_stock: !unavailableEl,
        is_available: !unavailableEl,
        age_restricted: !!restrictionEl,
        restrictions: restrictionEl?.textContent?.trim() || (limitEl?.textContent?.trim() ?? null),
        purchase_limit_text: limitEl?.textContent?.trim() || null,
        // Search context
        search_position: position,
        is_sponsored: !!sponsoredEl || !!sponsoredByText,
        sponsored_marker: sponsoredEl ? (sponsoredEl.getAttribute('data-testid') || sponsoredEl.getAttribute('class') || 'matched-selector') : (sponsoredByText ? 'matched-text' : null),
        // Ratings (DOM rarely exposes — try anyway)
        rating:       ratingMatch ? parseFloat(ratingMatch[1]) : null,
        rating_count: reviewMatch ? parseInt(reviewMatch[1], 10) : null,
        _source: 'dom-fallback',
        // Full forensic HTML — first 6KB of the tile. Lets us
        // back-extract any field later (sponsored markers, badges,
        // anything else) without re-scraping. Bounded to keep the
        // JSONL row size manageable.
        _raw_html: tile.outerHTML?.slice(0, 6000) || null,
      });
    }
    return out;
  });
  logSearch({ store: 'coles', query, result_count: domResult.length, ms: Date.now() - _t0, ok: true });
  return domResult;
}

// ── Matching ─────────────────────────────────────────────────────────

export function normaliseName(s) {
  return String(s || '').toLowerCase()
    .replace(/[-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip parenthetical content from a name. Watchlist entries often
 *  carry human-only notes in parens — "(home brand fine — Coles,
 *  Woolies Essentials acceptable)" — that must not poison token
 *  extraction or name-overlap. */
export function stripNotes(s) {
  return String(s || '').replace(/\s*\([^)]*\)/g, '').trim();
}

// Words to ignore when looking for name-overlap between watchlist and
// candidate. Units, pack-count nouns, and prepositions never identify a
// product on their own — "per kg" alone matches everything sold by weight.
const NAME_STOPWORDS = new Set([
  'the','and','or','of','for','with','a','an','in','on','to','per','each',
  'pack','packs','pk','kg','g','ml','l','cl','tab','tabs','tablet','tablets',
  'capsule','capsules','caps','count','ct','approx',
]);

// Words that mark a candidate as a processed/prepared variant rather
// than the raw ingredient. If the watchlist doesn't ask for one of
// these but the candidate has it, reject. (Observed: "Chicken Breast
// per kg" was matching "Chicken Breast Dino Nuggets 1kg" at Coles.)
export const PROCESSED_MARKERS = new Set([
  'nuggets','schnitzel','schnitzels','crumbed','kiev','kievs',
  'seasoned','marinated','sausages','sausage','patty','patties',
  'burger','burgers','meatballs','rissoles','frozen','ready','meal',
  'tenders','goujons','strips','battered','coated','flavoured','flavored',
  'smoked','glazed','rolled','stuffed',
  // Deli / lunch meat markers — catches "Don Chicken Breast Thinly Sliced"
  // matched against raw "Chicken Breast per kg" watchlists.
  'thinly','sliced','deli','cuts','shaved','luncheon','ham',
  'pastrami','salami','prosciutto','chorizo','jerky',
]);

export function significantWords(s) {
  return normaliseName(stripNotes(s)).split(/\s+/).filter(w =>
    w.length >= 3
    && !NAME_STOPWORDS.has(w)
    && !/^\d+(?:\.\d+)?$/.test(w)
    && !/^\d+(?:\.\d+)?[a-z]+$/.test(w)
  );
}

export function extractTokens(itemName) {
  const norm = normaliseName(stripNotes(itemName));
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
 *  most callers want.
 *
 *  opts.requires: array of substrings the candidate name MUST contain
 *  opts.brand: candidate's brand (Coles NEXT_DATA puts brand in a
 *    separate field — e.g. brand="Cold Power", name="Laundry Liquid
 *    Advanced Clean". We must check both for name-overlap, otherwise
 *    branded watchlist items get rejected because the brand isn't in
 *    the candidate name.). */
export function productMatchesDetailed(watchlistName, productName, unitString = '', opts = {}) {
  const want = extractTokens(watchlistName);
  // For matching purposes, combine brand + name so a watchlist word
  // can match in either. Display name stays unchanged elsewhere.
  const combinedName = opts.brand
    ? `${opts.brand} ${productName}`
    : productName;
  const got = normaliseName(combinedName);
  const unit = normaliseName(unitString);

  // Name-overlap gate — at least one distinctive watchlist word must
  // appear in the candidate. (Observed: "Oxyshred" pre-workout matched
  // against "Finish Quantum Ultimate 38 tabs" before this gate existed.)
  const wantWords = significantWords(watchlistName);
  const wantSet = new Set(wantWords);
  const gotTokens = got.split(/\s+/);
  const gotSet = new Set(gotTokens);
  if (wantWords.length > 0) {
    if (!wantWords.some(w => gotSet.has(w))) {
      return { ok: false, reason: `no-name-overlap (need any of: ${wantWords.slice(0, 3).join(', ')})` };
    }
  }

  // Processed-variant gate — only applied when the WATCHLIST asks for a
  // raw ingredient (no processed marker words in its own name). If the
  // user wrote "Beef Burgers 4 pack" they're already in processed-food
  // territory; "Patties" alongside "Burgers" shouldn't be a rejection.
  // But "Chicken Breast per kg" matching "Chicken Breast Dino Nuggets"
  // is exactly the bug this gate exists to catch.
  const watchlistIsRaw = !wantWords.some(w => PROCESSED_MARKERS.has(w));
  if (watchlistIsRaw) {
    const processedHit = gotTokens.find(w => PROCESSED_MARKERS.has(w));
    if (processedHit) {
      return { ok: false, reason: `processed-variant ("${processedHit}" not in watchlist)` };
    }
  }

  // NOTE: size and pack-count are no longer hard rejects. The watchlist
  // name's "500g" or "38 tabs" is a HINT, not a requirement — we want
  // the classifier to be free to pick a larger pack with better $/unit
  // ("Laundry Liquid 1L" should consider the 4L bottle if it's cheaper
  // per litre). The downstream Haiku classifier sees the cup string for
  // every candidate and picks on unit value. extractTokens still runs
  // because perKg / each still gate, and the size token is informative
  // even though no longer enforced here.
  if (want.perKg) {
    // Per-kg gate is now Haiku's job — the regex was either too loose
    // (accepting 80g lunch meat because the unit-string showed "$X/kg")
    // or too strict (rejecting all candidates because every Coles
    // chicken pack has "500g" in the name even though they're sold by
    // weight). Hand the disambiguation to the classifier; the
    // processed-variant gate above still catches "Dino Nuggets".
    // We only enforce a soft signal: if name has no "kg" hint anywhere
    // and unit string doesn't show per-kg, reject.
    const nameHasKg = /kg\b/.test(got);
    const unitHasKg = /\/\s*\d*\s*kg/.test(unit);
    if (!nameHasKg && !unitHasKg) {
      return { ok: false, reason: 'not-per-kg (no kg signal in name or unit)' };
    }
  }
  if (want.each && !want.perKg) {
    if (!/\beach\b/.test(got) && !/\beach\b/.test(unit)) {
      return { ok: false, reason: 'not-sold-each' };
    }
  }

  // Per-item requires gate — list of substrings the candidate name MUST
  // contain. Applied last so cheaper gates (overlap, processed) reject
  // first when they apply.
  if (Array.isArray(opts.requires) && opts.requires.length > 0) {
    const missing = opts.requires.find(req => !got.includes(normaliseName(req)));
    if (missing) {
      return { ok: false, reason: `requires-missing ("${missing}" not in candidate)` };
    }
  }

  return { ok: true, reason: null };
}

export function productMatches(watchlistName, productName, unitString = '', opts = {}) {
  return productMatchesDetailed(watchlistName, productName, unitString, opts).ok;
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
