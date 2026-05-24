#!/usr/bin/env node
/**
 * GROCERY CALIBRATOR — periodic accuracy probe for the price matcher.
 *
 * productMatches can fail two ways:
 *   - false positive: accepts a wrong product (e.g. Oxyshred matched
 *     against "Finish Quantum Ultimate 38 tabs" at $4.90)
 *   - false negative: rejects a real match (e.g. "Chicken Thigh Fillets
 *     per kg" rejecting "Chicken Thigh Cutlets approx 1.1kg")
 *
 * The watch script silently drops rejects. This calibrator runs the same
 * searches with full visibility — every rejection comes with a reason,
 * and items where the matcher LOOKS too strict (top-priced candidate has
 * strong word overlap but got rejected) get flagged for review.
 *
 * Output:
 *   ~/.claude-gombwe/data/grocery-calibration-<ISO>.json   (full report)
 *   ~/.claude-gombwe/data/grocery-calibration-latest.json  (pointer)
 *   stdout summary of flagged items
 *
 * Runs automatically from grocery-watch when the last calibration is
 * older than 48h. Can also be invoked directly.
 */

import {
  connectChrome, discoverColesApi,
  colesSearch, woolworthsSearch,
  productMatchesDetailed, significantWords, normaliseName,
} from './grocery-lib.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');
const WATCHLIST = join(DATA_DIR, 'grocery-watchlist.json');
const LATEST = join(DATA_DIR, 'grocery-calibration-latest.json');
const TOP_N_CANDIDATES = 5;
const SUSPECT_PRICE_FRACTION = 0.3;

export function isCalibrationStale(maxAgeHours = 48) {
  if (!existsSync(LATEST)) return true;
  try {
    const cal = JSON.parse(readFileSync(LATEST, 'utf8'));
    const ageMs = Date.now() - new Date(cal.calibrated_at).getTime();
    return ageMs > maxAgeHours * 3600 * 1000;
  } catch {
    return true;
  }
}

function loadWatchlist() {
  return JSON.parse(readFileSync(WATCHLIST, 'utf8')).items || [];
}

function probeOneStore(item, candidates) {
  const enriched = candidates.map(p => {
    const d = productMatchesDetailed(item.name, p.name, p.cup || '', { requires: item.requires });
    return { name: p.name, price: p.price, cup: p.cup || '', accepted: d.ok, reason: d.reason };
  });
  const accepted = enriched.filter(c => c.accepted)
    .sort((a, b) => a.price - b.price);
  const rejected = enriched.filter(c => !c.accepted)
    .sort((a, b) => a.price - b.price);
  const kept = accepted[0] || null;

  const flags = [];
  if (kept && typeof item.expected_promo === 'number'
      && kept.price < item.expected_promo * SUSPECT_PRICE_FRACTION) {
    flags.push(`suspect-low-price ($${kept.price} < ${SUSPECT_PRICE_FRACTION * 100}% of expected_promo $${item.expected_promo})`);
  }
  // False-negative heuristic: nothing accepted, but the cheapest rejected
  // candidate contains ALL distinctive watchlist words. Strong signal that
  // the matcher is too strict for this item.
  if (!kept && rejected.length > 0) {
    const want = significantWords(item.name);
    if (want.length > 0) {
      for (const r of rejected.slice(0, TOP_N_CANDIDATES)) {
        const gotWords = new Set(normaliseName(r.name).split(/\s+/));
        const overlap = want.filter(w => gotWords.has(w));
        if (overlap.length === want.length) {
          flags.push(`false-negative-likely (rejected "${r.name}" has all watchlist words: ${want.join(', ')})`);
          break;
        }
      }
    }
  }

  return {
    candidates_seen: candidates.length,
    candidates_accepted: accepted.length,
    kept,
    top_rejected: rejected.slice(0, TOP_N_CANDIDATES),
    flags,
  };
}

async function searchBothStores(item, wPage, cPage, apiPattern) {
  const wAll = [], cAll = [];
  for (const term of item.search_terms || [item.name]) {
    try {
      const ws = await woolworthsSearch(wPage, term);
      if (Array.isArray(ws)) wAll.push(...ws);
    } catch (err) { /* search may transiently fail — keep going */ }
    try {
      const cs = await colesSearch(cPage, term, apiPattern);
      if (Array.isArray(cs)) cAll.push(...cs);
    } catch (err) { /* same */ }
    if (wAll.length > 8 && cAll.length > 8) break;
  }
  // Dedupe by name to keep the candidate list tight
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter(p => {
      const k = `${p.name}|${p.price}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { wAll: dedupe(wAll), cAll: dedupe(cAll) };
}

export async function runCalibration({ itemsFilter = null } = {}) {
  console.log('[calibrate] connecting to Chrome...');
  const browser = await connectChrome();
  const pages = await browser.pages();
  const cPage = pages.find(p => p.url()?.includes('coles.com.au'))
            ?? pages.find(p => !p.url()?.startsWith('chrome'))
            ?? await browser.newPage();
  const wPage = pages.find(p => p.url()?.includes('woolworths.com.au'))
            ?? await browser.newPage();
  const apiPattern = await discoverColesApi(cPage);
  console.log(`[calibrate] Coles API: ${apiPattern || '<DOM-only>'}`);

  const allItems = loadWatchlist();
  const items = itemsFilter
    ? allItems.filter(it => itemsFilter.some(f => it.name.toLowerCase().includes(f.toLowerCase())))
    : allItems;
  console.log(`[calibrate] probing ${items.length} item${items.length === 1 ? '' : 's'}`);

  const report = { calibrated_at: new Date().toISOString(), items: [] };

  for (const item of items) {
    process.stdout.write(`  ${item.name}... `);
    const { wAll, cAll } = await searchBothStores(item, wPage, cPage, apiPattern);
    const coles = probeOneStore(item, cAll);
    const woolies = probeOneStore(item, wAll);
    const allFlags = [...coles.flags.map(f => `coles: ${f}`),
                      ...woolies.flags.map(f => `woolies: ${f}`)];
    report.items.push({
      name: item.name,
      expected_promo: item.expected_promo,
      max_price: item.max_price,
      coles, woolies,
      flags: allFlags,
    });
    const status = allFlags.length > 0 ? `⚠ ${allFlags.length} flag${allFlags.length === 1 ? '' : 's'}`
                 : (coles.kept || woolies.kept) ? '✓' : '∅ no-data';
    console.log(status);
  }

  const tsFile = `grocery-calibration-${report.calibrated_at.replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(DATA_DIR, tsFile), JSON.stringify(report, null, 2));
  writeFileSync(LATEST, JSON.stringify(report, null, 2));

  // stdout summary — what the user actually wants to see
  const flagged = report.items.filter(it => it.flags.length > 0);
  const noData = report.items.filter(it => !it.coles.kept && !it.woolies.kept && it.flags.length === 0);
  console.log(`\n── calibration summary ──`);
  console.log(`  total probed: ${report.items.length}`);
  console.log(`  matched OK:   ${report.items.length - flagged.length - noData.length}`);
  console.log(`  flagged:      ${flagged.length}`);
  console.log(`  no-data:      ${noData.length}`);

  if (flagged.length > 0) {
    console.log(`\n── flagged items needing review ──`);
    for (const it of flagged) {
      console.log(`\n  ${it.name}  (expected_promo $${it.expected_promo}, ceiling $${it.max_price})`);
      for (const f of it.flags) console.log(`    ⚠ ${f}`);
      for (const store of ['coles', 'woolies']) {
        const s = it[store];
        if (s.kept) {
          console.log(`    ${store} kept: "${s.kept.name}" @ $${s.kept.price}`);
        }
        if (s.top_rejected.length > 0 && !s.kept) {
          console.log(`    ${store} top rejects:`);
          for (const r of s.top_rejected.slice(0, 3)) {
            console.log(`      - $${r.price} "${r.name}" — ${r.reason}`);
          }
        }
      }
    }
  }

  // Surface no-data items too — the user often wants to know WHY a
  // watchlist item came back empty. Without this, "no-data" looks
  // identical to "matcher silently broken".
  if (noData.length > 0) {
    console.log(`\n── no-data items (matcher rejected everything) ──`);
    for (const it of noData) {
      console.log(`\n  ${it.name}`);
      for (const store of ['coles', 'woolies']) {
        const s = it[store];
        if (s.top_rejected.length === 0) {
          console.log(`    ${store}: 0 candidates returned by search`);
          continue;
        }
        console.log(`    ${store}: ${s.candidates_seen} candidates, all rejected. Top 3 by price:`);
        for (const r of s.top_rejected.slice(0, 3)) {
          console.log(`      - $${r.price} "${r.name.slice(0, 70)}" — ${r.reason}`);
        }
      }
    }
  }
  console.log(`\n  full report: ${join(DATA_DIR, tsFile)}`);

  await browser.disconnect?.();
  return report;
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`
                  || process.argv[1]?.endsWith('grocery-calibrate.mjs');

if (isMainModule) {
  const args = process.argv.slice(2);
  const itemsArg = args.find(a => a.startsWith('--items='));
  const itemsFilter = itemsArg ? itemsArg.slice('--items='.length).split(',').map(s => s.trim()) : null;
  runCalibration({ itemsFilter }).catch(err => {
    console.error('Calibration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
