#!/usr/bin/env node
/**
 * GROCERY PDP ENRICHMENT — background backfill of product-detail-page data.
 *
 * Search-result tiles carry maybe 15-20 fields per product. Product
 * detail pages carry the GOOD stuff: full description, ingredients,
 * nutrition info, allergens, country of origin, manufacturer, multiple
 * images, full reviews, category-specific specs.
 *
 * This script walks the catalog and progressively fetches each PDP it
 * hasn't seen before (or whose snapshot is older than the refresh
 * window). Designed to run slowly as a cron job — one batch per day,
 * limited products per batch — so the dataset enriches over weeks
 * without ever hammering the retailers.
 *
 * Run:
 *   node scripts/grocery-pdp-enrich.mjs                  # 20 products
 *   node scripts/grocery-pdp-enrich.mjs --limit 50
 *   node scripts/grocery-pdp-enrich.mjs --store=coles    # one retailer
 *   node scripts/grocery-pdp-enrich.mjs --refresh-days 30  # re-enrich older than N days
 *
 * Outputs:
 *   ~/.claude-gombwe/data/grocery-product-details.jsonl
 *       Append-only — every enrichment attempt logged with ts, store,
 *       product_id, extracted fields, success/fail.
 *   ~/.claude-gombwe/data/grocery-products.json
 *       Catalog entries gain pdp_enriched_at + latest enriched fields.
 *
 * Anti-detection:
 *   - Visits the product page like a real shopper (waitForSelector,
 *     scroll, small dwell time)
 *   - Jittered 4-12s delay between PDPs
 *   - Hard cap per run (default 20) so we never look like a crawler
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { connectChrome, jitter } from './grocery-lib.mjs';

const DATA_DIR   = join(homedir(), '.claude-gombwe', 'data');
const CATALOG    = join(DATA_DIR, 'grocery-products.json');
const DETAILS_LOG= join(DATA_DIR, 'grocery-product-details.jsonl');

const DEFAULT_LIMIT = 20;
const DEFAULT_REFRESH_DAYS = 30;
const PDP_TIMEOUT_MS = 25000;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const a = args.find(x => x.startsWith(`--${flag}=`) || x === `--${flag}`);
    if (!a) return fallback;
    return a.includes('=') ? a.split('=')[1] : true;
  };
  return {
    limit: parseInt(get('limit', DEFAULT_LIMIT), 10),
    store: get('store', null),
    refreshDays: parseInt(get('refresh-days', DEFAULT_REFRESH_DAYS), 10),
    dryRun: get('dry-run', false),
  };
}

function loadCatalog() {
  if (!existsSync(CATALOG)) {
    console.error(`No catalog at ${CATALOG} — run grocery-watch or grocery-calibrate first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CATALOG, 'utf8'));
}

function saveCatalog(catalog) {
  catalog.updated_at = new Date().toISOString();
  writeFileSync(CATALOG, JSON.stringify(catalog, null, 2), { mode: 0o600 });
}

/** Pick products that need enrichment. Sorted oldest-enriched first
 *  (or never-enriched first), then by observation_count desc so the
 *  most-frequently-seen products get enriched ahead of one-offs. */
function pickProductsToEnrich(catalog, { limit, store, refreshDays }) {
  const now = Date.now();
  const refreshMs = refreshDays * 24 * 3600 * 1000;
  const eligible = Object.entries(catalog.products)
    .filter(([_, p]) => {
      if (store && p.store !== store) return false;
      if (!p.latest_url) return false;  // can't fetch without URL
      if (!p.pdp_enriched_at) return true;  // never enriched
      const age = now - new Date(p.pdp_enriched_at).getTime();
      return age > refreshMs;  // stale
    })
    .sort(([_a, a], [_b, b]) => {
      // Never-enriched first
      if (!a.pdp_enriched_at && b.pdp_enriched_at) return -1;
      if (a.pdp_enriched_at && !b.pdp_enriched_at) return 1;
      // Then by observation count (popular products first)
      return (b.observation_count || 0) - (a.observation_count || 0);
    });
  return eligible.slice(0, limit);
}

/** Extract structured data from a PDP. JSON-LD carries the bulk; we
 *  also pick up common selectors as a backstop. Specific schemas
 *  differ between Coles and Woolies, but JSON-LD Product is mostly
 *  the same shape across both because they follow schema.org. */
async function enrichOne(page, product) {
  const ts = new Date().toISOString();
  const base = {
    ts,
    store: product.store,
    product_id: product.product_id,
    url: product.latest_url,
  };
  try {
    await page.goto(product.latest_url, {
      waitUntil: 'domcontentloaded',
      timeout: PDP_TIMEOUT_MS,
    });
    // Give SPAs a moment to hydrate.
    try { await page.waitForSelector('h1, [data-testid*="product"]', { timeout: 8000 }); }
    catch { /* hydration didn't fire — extract what we can anyway */ }
    // Light user-like scroll so lazy-loaded sections (reviews, nutrition)
    // get rendered.
    await page.evaluate(() => window.scrollBy({ top: document.body.scrollHeight / 2, behavior: 'instant' }));
    await new Promise(r => setTimeout(r, 1500));

    const extracted = await page.evaluate(() => {
      const out = {};

      // 1. JSON-LD Product schema — both retailers use schema.org/Product
      // here. This is the gold-standard structured-data path; selectors
      // are belt-and-braces.
      const ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
      const ldBlocks = [];
      for (const n of ldNodes) {
        try { ldBlocks.push(JSON.parse(n.textContent)); } catch {}
      }
      if (ldBlocks.length) {
        out.json_ld = ldBlocks;
        const ld = ldBlocks.find(b => b?.['@type'] === 'Product') || ldBlocks[0];
        if (ld && typeof ld === 'object') {
          const stripHtml = (s) => typeof s === 'string'
            ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim()
            : null;
          out.ld_name           = ld.name?.trim() || null;
          out.ld_description    = stripHtml(ld.description);
          out.ld_image          = typeof ld.image === 'string' ? ld.image
                                : Array.isArray(ld.image) ? ld.image[0] : null;
          out.ld_brand          = ld.brand?.name || ld.brand || null;
          out.ld_gtin           = ld.gtin || ld.gtin13 || ld.gtin12 || ld.gtin8 || null;
          out.ld_sku            = ld.sku || null;
          out.ld_availability   = ld.offers?.availability || null;
          out.ld_price          = typeof ld.offers?.price === 'number' ? ld.offers.price : null;
          out.ld_currency       = ld.offers?.priceCurrency || null;
          out.ld_unit_price     = typeof ld.offers?.priceSpecification?.price === 'number'
                                ? ld.offers.priceSpecification.price : null;
          out.ld_unit_text      = ld.offers?.priceSpecification?.unitText || null;
        }
      }

      // 2. Generic selectors for the common fields
      const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
      out.h1                 = txt('h1');
      out.description        = txt('[data-testid*="description"]')
                            || txt('[itemprop="description"]')
                            || txt('.product-description')
                            || txt('section[id*="description"]');
      out.ingredients        = txt('[data-testid*="ingredient"]')
                            || txt('.product-ingredients')
                            || txt('section[id*="ingredient"]');
      out.country_of_origin  = txt('[data-testid*="country-of-origin"]')
                            || txt('[data-testid*="origin"]');
      out.manufacturer       = txt('[data-testid*="manufacturer"]')
                            || txt('[itemprop="manufacturer"]');
      out.warnings           = txt('[data-testid*="warning"]')
                            || txt('.product-warnings');
      out.allergens          = txt('[data-testid*="allergen"]')
                            || txt('.product-allergens');

      // 3. All images
      const imgs = Array.from(document.querySelectorAll(
        '[data-testid*="product-image"] img, .product-images img, [class*="ImageGallery"] img'
      )).map(i => i.src).filter(Boolean);
      out.images = [...new Set(imgs)];

      // 4. Nutrition panel (Woolies + Coles use tables; capture as raw rows)
      const nutritionRows = Array.from(document.querySelectorAll(
        '[data-testid*="nutrition"] tr, .nutrition-table tr, table[class*="nutri"] tr'
      )).map(tr => Array.from(tr.querySelectorAll('th, td')).map(c => c.textContent.trim()))
        .filter(row => row.length >= 2);
      if (nutritionRows.length) out.nutrition_rows = nutritionRows;

      // 5. Reviews summary (counts + average if shown on PDP)
      out.review_summary = txt('[data-testid*="review-summary"]')
                        || txt('[data-testid*="rating-summary"]');

      // 6. Anything that looks like a spec table (key/value pairs)
      const specs = {};
      for (const dl of document.querySelectorAll('dl')) {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
          const k = dts[i].textContent.trim();
          const v = dds[i].textContent.trim();
          if (k && v) specs[k] = v;
        }
      }
      if (Object.keys(specs).length) out.specs = specs;

      return out;
    });

    return { ...base, ok: true, ...extracted };
  } catch (err) {
    return { ...base, ok: false, error: err.message };
  }
}

async function main() {
  const opts = parseArgs();
  const catalog = loadCatalog();
  const queue = pickProductsToEnrich(catalog, opts);

  console.log(`[pdp] catalog: ${Object.keys(catalog.products).length} products`);
  console.log(`[pdp] queue (limit ${opts.limit}${opts.store ? `, store=${opts.store}` : ''}): ${queue.length}`);
  if (opts.dryRun) {
    for (const [key, p] of queue) {
      console.log(`  ${key}  ${p.latest_name || '(no name)'}`);
    }
    return;
  }
  if (queue.length === 0) {
    console.log('[pdp] nothing to enrich — all products fresh or no candidates.');
    return;
  }

  mkdirSync(dirname(DETAILS_LOG), { recursive: true });

  const browser = await connectChrome();
  const pages = await browser.pages();
  const page = pages.find(p => !p.url()?.startsWith('chrome'))
            ?? await browser.newPage();

  let okCount = 0, failCount = 0;
  for (const [key, product] of queue) {
    process.stdout.write(`  ${key} ${(product.latest_name || '').slice(0, 50)}... `);
    const detail = await enrichOne(page, product);
    appendFileSync(DETAILS_LOG, JSON.stringify(detail) + '\n', { mode: 0o600 });
    if (detail.ok) {
      okCount++;
      const entry = catalog.products[key];
      if (entry) {
        entry.pdp_enriched_at = detail.ts;
        // Prefer JSON-LD (cleaner, retailer-canonical) over DOM-selector
        // backups; fall through to DOM when JSON-LD field is empty.
        const desc = detail.ld_description || detail.description;
        if (desc)                       entry.latest_pdp_description = desc.slice(0, 1000);
        if (detail.ingredients)         entry.latest_pdp_ingredients = detail.ingredients.slice(0, 500);
        if (detail.country_of_origin)   entry.latest_pdp_origin = detail.country_of_origin;
        if (detail.manufacturer)        entry.latest_pdp_manufacturer = detail.manufacturer;
        if (detail.allergens)           entry.latest_pdp_allergens = detail.allergens;
        if (detail.images?.length)      entry.latest_pdp_image_count = detail.images.length;
        if (detail.nutrition_rows)      entry.latest_pdp_has_nutrition = true;
        // JSON-LD-derived first-class fields
        if (detail.ld_brand)            entry.latest_pdp_brand = detail.ld_brand;
        if (detail.ld_gtin)             entry.latest_pdp_gtin = detail.ld_gtin;
        if (detail.ld_sku)              entry.latest_pdp_sku = detail.ld_sku;
        if (detail.ld_availability)     entry.latest_pdp_availability = detail.ld_availability;
        if (detail.ld_image)            entry.latest_pdp_image = detail.ld_image;
        if (detail.ld_unit_price != null) entry.latest_pdp_unit_price = detail.ld_unit_price;
        if (detail.ld_unit_text)        entry.latest_pdp_unit_text = detail.ld_unit_text;
      }
      const tags = [
        detail.json_ld ? 'jsonld' : null,
        detail.ld_description ? 'desc' : null,
        detail.ld_gtin ? 'gtin' : null,
        detail.ingredients ? 'ingr' : null,
        detail.images?.length ? `${detail.images.length}img` : null,
      ].filter(Boolean).join('+');
      console.log(`✓ ${tags || 'minimal'}`);
    } else {
      failCount++;
      console.log(`✗ ${detail.error}`);
    }
    saveCatalog(catalog);  // persist per-product so crashes don't lose progress
    // Jittered delay between PDPs — defensive. Don't look like a crawler.
    await jitter(4000, 12000);
  }

  console.log(`\n[pdp] enriched ${okCount} OK, ${failCount} failed. Log: ${DETAILS_LOG}`);
  await browser.disconnect?.();
}

main().catch(err => {
  console.error('PDP enrichment failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
