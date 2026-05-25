/**
 * GROCERY SPOT PRICE — fetch the current price of a known product by
 * going straight to its PDP, bypassing search entirely.
 *
 * Once a watchlist item has a cached resolution (product_id + URL),
 * there's no reason to re-run the search each scrape:
 *   - Coles search ranking changes between runs (noise)
 *   - Coles API discovery keeps failing (DOM fallback is slow)
 *   - The matcher might pick differently each run (until cached)
 *
 * Direct PDP fetch is faster, more reliable, less detectable, and
 * frictionless once we know the URL.
 *
 * What we extract from the PDP (preferring JSON-LD, falling back to
 * DOM selectors):
 *   - current price + currency
 *   - was-price / on-special / save-amount
 *   - availability (in-stock / out-of-stock)
 *   - latest cup string (per-unit price)
 *   - image URL (refresh if Coles rotated it)
 *
 * Search-based scraping is only used when:
 *   - the resolution is missing (first time for this watchlist item), OR
 *   - the cached PDP returns 404 / "product not found" (delisted), OR
 *   - the user passed --force-search.
 */

import { wait, jitter } from './grocery-lib.mjs';

const PDP_TIMEOUT_MS = 20000;

/**
 * Fetch the spot price of a single product via direct PDP load.
 * @returns {Promise<{ ok: bool, price?: number, was_price?: number,
 *   is_on_special?: bool, save_amount?: number, in_stock?: bool,
 *   cup?: string, name?: string, image_url?: string, error?: string,
 *   _source: 'pdp-jsonld'|'pdp-dom'|'pdp-error' }>}
 */
export async function fetchSpotPrice(page, url, store) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PDP_TIMEOUT_MS });
    // Coles PDP is a Next.js SPA — JSON-LD and price elements only
    // appear after hydration. Wait for a product element, scroll a
    // little to trigger lazy data, give the React tree time to settle.
    try {
      await page.waitForSelector('h1, [data-testid*="product"], [itemprop="price"]', { timeout: 8000 });
    } catch { /* didn't render — fall through, may still have static data */ }
    if (store === 'coles') {
      await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'instant' }));
      await new Promise(r => setTimeout(r, 1500));
    }

    const data = await page.evaluate(() => {
      const out = { _source: 'pdp-error' };

      // JSON-LD is the most reliable; both retailers use schema.org/Product.
      // Handle direct objects, arrays, AND `@graph` arrays (some Coles
      // PDPs wrap Product inside a graph).
      const ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
      const collectProducts = (ld) => {
        const blocks = Array.isArray(ld) ? ld : [ld];
        const out = [];
        for (const b of blocks) {
          if (b?.['@type'] === 'Product') out.push(b);
          if (Array.isArray(b?.['@graph'])) {
            for (const g of b['@graph']) {
              if (g?.['@type'] === 'Product') out.push(g);
            }
          }
        }
        return out;
      };
      let allProducts = [];
      for (const n of ldNodes) {
        try { allProducts.push(...collectProducts(JSON.parse(n.textContent))); } catch {}
      }
      for (const product of allProducts) {
        if (!product) continue;
        out._source = 'pdp-jsonld';
        out.name = product.name || null;
        if (typeof product.image === 'string') out.image_url = product.image;
        else if (Array.isArray(product.image)) out.image_url = product.image[0];

        // Coles wraps offers as an array, Woolies as a single object.
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers].filter(Boolean);
        for (const offer of offers) {
          if (!offer) continue;
          if (out.price == null && typeof offer.price === 'number') out.price = offer.price;
          else if (out.price == null && typeof offer.price === 'string') out.price = parseFloat(offer.price);
          if (offer.priceCurrency) out.currency = offer.priceCurrency;
          const avail = offer.availability || '';
          out.in_stock = !/OutOfStock|Discontinued|SoldOut/i.test(avail);
          if (offer.priceSpecification) {
            const ps = offer.priceSpecification;
            if (typeof ps.price === 'number' && ps.unitText) {
              out.cup = `\$${ps.price} / ${ps.unitText}`;
            }
          }
          if (out.price != null) break;
        }
        if (out.price != null) break;
      }

      // DOM fallback — extract from MAIN product area only. Coles PDP
      // also renders recommended-product tiles below; we must avoid
      // picking their prices. Scope queries to the first hero block.
      if (out.price == null) {
        out._source = 'pdp-dom';
        // Find the main product container — first occurrence of these
        // hero selectors. Falls back to whole document only if hero
        // wrappers don't exist.
        const hero =
            document.querySelector('[itemtype*="schema.org/Product"]')
         || document.querySelector('main [data-testid*="product-details"]')
         || document.querySelector('main [class*="product-details"]')
         || document.querySelector('main [class*="ProductHero"]')
         || document.querySelector('main section:first-of-type')
         || document.querySelector('article')
         || document;
        const txt = (sel) => hero.querySelector(sel)?.textContent?.trim();
        const attr = (sel, a) => hero.querySelector(sel)?.getAttribute(a);
        const priceTxt = attr('[itemprop="price"]', 'content')
                      || txt('[itemprop="price"]')
                      || txt('[data-testid="product_price"] .price__value')
                      || txt('[data-testid="pricing"] .price__value')
                      || txt('.price__value');
        if (priceTxt) {
          const m = priceTxt.match(/\$?\s*(\d+(?:\.\d+)?)/);
          if (m) out.price = parseFloat(m[1]);
        }
        out.name = out.name || txt('h1');
        const wasTxt = txt('.price__was');
        if (wasTxt) {
          const m = wasTxt.match(/\$?\s*(\d+(?:\.\d+)?)/);
          if (m) out.was_price = parseFloat(m[1]);
        }
        const saveTxt = txt('.badge-label');
        if (saveTxt) {
          const m = saveTxt.match(/save\s*\$?\s*(\d+(?:\.\d+)?)/i);
          if (m) out.save_amount = parseFloat(m[1]);
        }
        const cupTxt = txt('.price__calculation_method');
        if (cupTxt) out.cup = cupTxt;
        const oos = hero.querySelector('[data-testid*="unavailable"], [data-testid*="out-of-stock"], [class*="UnavailableMessage"]');
        if (out.in_stock == null) out.in_stock = !oos;
      }

      // Promo derivation if was-price present but on-special bool isn't
      if (out.was_price && out.price && out.was_price > out.price) {
        out.is_on_special = true;
        if (out.save_amount == null) out.save_amount = +(out.was_price - out.price).toFixed(2);
      }

      return out;
    });

    if (data.price == null) {
      return { ok: false, error: 'price-not-extractable', _source: data._source };
    }
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message || String(err), _source: 'pdp-error' };
  }
}

/**
 * Fetch spot prices for a batch of products sequentially with jittered
 * delays between requests. Caller passes a page (Chrome tab) plus the
 * list of (resolution, store) pairs.
 *
 * @param {Page} page - puppeteer page already navigated to the store
 * @param {Array<{url: string, store: string, product_id: string, watchlist_item: string}>} batch
 * @returns {Promise<Map<string, object>>} keyed by `${store}:${product_id}`
 */
export async function fetchSpotPricesBatch(page, batch, opts = {}) {
  const { jitterMin = 600, jitterMax = 2200 } = opts;
  const results = new Map();
  for (const job of batch) {
    const key = `${job.store}:${job.product_id}`;
    const result = await fetchSpotPrice(page, job.url, job.store);
    results.set(key, { ...result, ...job });
    await jitter(jitterMin, jitterMax);
  }
  return results;
}
