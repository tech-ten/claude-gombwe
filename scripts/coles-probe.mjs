#!/usr/bin/env node
/**
 * COLES PROBE — diagnose what the Coles search actually returns.
 *
 * Hits Coles search for a handful of items (especially the ones with
 * known-wrong prices in grocery-watch output), dumps RAW data from both
 * the discovered internal API and the DOM scrape. Lets us see exactly
 * which field/element the scraper is misreading.
 *
 * Run:
 *   node scripts/coles-probe.mjs
 *
 * Output: writes ~/.claude-gombwe/data/coles-probe-<ISO>.json with the
 * full structure of each search response, AND prints a summary table
 * showing what price the current scraper would extract vs what's
 * visible on the page.
 *
 * Requires: logged-in Chrome at port 19222 (same as grocery-buy / grocery-watch).
 */

import { connectChrome, discoverColesApi, colesSearch } from './grocery-lib.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROBES = [
  'Finish Quantum Ultimate 38 tabs',
  'chicken breast per kg',
  'milk 2L',                  // baseline — should be ~$3
  'Butter 250g',              // baseline — should be ~$7.50
  'whole chicken',            // baseline — should be ~$13.50
];

async function main() {
  console.log('Connecting to logged-in Chrome…');
  const { browser, page } = await connectChrome();

  console.log('Discovering Coles internal API…');
  const apiPattern = await discoverColesApi(page);
  console.log(`  API pattern: ${apiPattern || '<none — DOM-only>'}`);

  const results = [];

  for (const query of PROBES) {
    console.log(`\n=== probing: ${query} ===`);

    // Use the existing scraper's logic (so we see exactly what
    // grocery-watch / grocery-buy would record)
    const items = await colesSearch(page, query, apiPattern);
    console.log(`  scraper returned ${items.length} items`);
    if (items.length > 0) {
      console.log(`  first 3 results (what the scraper sees):`);
      for (const it of items.slice(0, 3)) {
        console.log(`    - "${it.name}" → $${it.price}  cup=[${it.cup}]`);
      }
    }

    // ALSO dump the raw API response (if we have an API pattern) so we
    // can see the full shape — not just what the scraper extracted.
    let rawApi = null;
    if (apiPattern) {
      try {
        rawApi = await page.evaluate(async (q, tpl) => {
          const url = tpl.replace('{Q}', encodeURIComponent(q));
          const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
          if (!res.ok) return { _error: `HTTP ${res.status}` };
          return await res.json();
        }, query, apiPattern);
        console.log(`  raw API response: top-level keys = ${Object.keys(rawApi || {}).join(', ')}`);
      } catch (err) {
        console.log(`  raw API fetch failed: ${err.message}`);
      }
    }

    // ALSO dump the DOM for the first product tile so we can see what's
    // in the tile (price, unit price, savings, etc.) — helps if the
    // DOM-scrape path is the culprit.
    let firstTileHTML = null;
    try {
      await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      try { await page.waitForSelector('[data-testid="product-tile"]', { timeout: 8000 }); } catch {}
      firstTileHTML = await page.evaluate(() => {
        const tile = document.querySelector('[data-testid="product-tile"]');
        return tile ? tile.outerHTML.slice(0, 3000) : null;
      });
    } catch (err) {
      console.log(`  DOM probe failed: ${err.message}`);
    }

    results.push({
      query,
      scraperItems: items.slice(0, 5),
      rawApi: rawApi ? JSON.parse(JSON.stringify(rawApi).slice(0, 20000)) : null,
      firstTileHTML,
    });
  }

  const outPath = join(homedir(), '.claude-gombwe', 'data',
    `coles-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify({
    probedAt: new Date().toISOString(),
    apiPattern,
    results,
  }, null, 2));

  console.log(`\n✓ Full probe data written to:\n  ${outPath}\n`);
  console.log('Next: share that file (or the relevant excerpt) so I can see the actual fields/markup and fix the scraper precisely.');

  await browser.disconnect?.();
}

main().catch(err => {
  console.error('Probe failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
