#!/usr/bin/env node
/**
 * GROCERY ALIASES — what each retailer calls our watchlist items.
 *
 * Builds a lookup from the historical price log + current deals snapshot:
 * for every watchlist item, lists the actual Coles + Woolworths product
 * names it has matched against over time, with observation counts and
 * most-recent price. Useful for:
 *   - sanity-checking that watchlist names are being correctly mapped
 *   - spotting bad historical matches that the new matcher would reject
 *   - documenting "what we mean when we say X" across the two stores
 *
 * Output:
 *   ~/.claude-gombwe/data/grocery-aliases.json (structured, alphabetical)
 *   stdout: human-readable table
 *
 * Run:
 *   node scripts/grocery-aliases.mjs              # all items
 *   node scripts/grocery-aliases.mjs --items=chicken,milk
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR  = join(homedir(), '.claude-gombwe', 'data');
const WATCHLIST = join(DATA_DIR, 'grocery-watchlist.json');
const PRICE_LOG = join(DATA_DIR, 'grocery-prices.jsonl');
const DEALS     = join(DATA_DIR, 'grocery-deals-latest.json');
const OUT       = join(DATA_DIR, 'grocery-aliases.json');

function loadJSONL(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function buildAliases({ itemsFilter = null } = {}) {
  const watchlist = JSON.parse(readFileSync(WATCHLIST, 'utf8')).items || [];
  const items = itemsFilter
    ? watchlist.filter(it => itemsFilter.some(f => it.name.toLowerCase().includes(f.toLowerCase())))
    : watchlist;

  const observations = loadJSONL(PRICE_LOG);
  const deals = existsSync(DEALS) ? JSON.parse(readFileSync(DEALS, 'utf8')) : { items: [] };
  const dealByItem = new Map(deals.items.map(it => [it.name, it]));

  const aliases = {};

  for (const item of items) {
    const myObs = observations.filter(o => o.item === item.name);
    const collect = (storeKey, nameKey, priceKey) => {
      const byName = new Map();
      for (const o of myObs) {
        const name = o[nameKey];
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, { count: 0, latestTs: '', latestPrice: null });
        const entry = byName.get(name);
        entry.count += 1;
        if (o.ts > entry.latestTs) {
          entry.latestTs = o.ts;
          entry.latestPrice = o[priceKey] ?? null;
        }
      }
      // Mark which alias is the CURRENT match (from deals snapshot)
      const currentMatch = dealByItem.get(item.name)?.current?.[storeKey]?.name || null;
      return Array.from(byName.entries())
        .map(([name, v]) => ({ name, ...v, current: name === currentMatch }))
        .sort((a, b) => b.count - a.count || (b.latestTs > a.latestTs ? 1 : -1));
    };

    aliases[item.name] = {
      watchlist_search_terms: item.search_terms || [],
      requires: item.requires || [],
      coles:   collect('coles', 'coles_name', 'coles_price'),
      woolies: collect('woolworths', 'woolworths_name', 'woolworths_price'),
    };
  }

  return aliases;
}

function printTable(aliases) {
  const names = Object.keys(aliases).sort();
  console.log(`=== Grocery aliases — ${names.length} watchlist item${names.length === 1 ? '' : 's'} ===\n`);
  for (const name of names) {
    const a = aliases[name];
    console.log(`▌ ${name}`);
    if (a.requires.length > 0) console.log(`    requires: ${a.requires.join(', ')}`);
    for (const store of ['coles', 'woolies']) {
      const list = a[store];
      if (list.length === 0) {
        console.log(`    ${store.toUpperCase().padEnd(8)} <no historical matches>`);
        continue;
      }
      console.log(`    ${store.toUpperCase()}:`);
      for (const entry of list.slice(0, 5)) {
        const marker = entry.current ? '▶' : ' ';
        const price = entry.latestPrice != null ? `$${entry.latestPrice}` : '—';
        console.log(`     ${marker} (${entry.count}× obs, latest ${price})  "${entry.name}"`);
      }
      if (list.length > 5) console.log(`        … and ${list.length - 5} more`);
    }
    console.log('');
  }
  console.log('▶ = currently-recorded match in latest deals snapshot');
}

const args = process.argv.slice(2);
const itemsArg = args.find(a => a.startsWith('--items='));
const itemsFilter = itemsArg ? itemsArg.slice('--items='.length).split(',').map(s => s.trim()) : null;
const quiet = args.includes('--quiet');

const aliases = buildAliases({ itemsFilter });
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), aliases }, null, 2));

if (!quiet) {
  printTable(aliases);
  console.log(`\nFull JSON: ${OUT}`);
}
