#!/usr/bin/env node

/**
 * Grocery automation — search, compare, and add to cart at Woolworths and Coles.
 * Uses your logged-in Chrome session via remote debugging.
 *
 * Usage:
 *   node scripts/grocery.mjs compare "milk 2L" "eggs" "bbq sauce"
 *   node scripts/grocery.mjs order woolworths "milk 2L" "eggs" "bbq sauce"
 *   node scripts/grocery.mjs order coles "milk 2L" "eggs"
 *   node scripts/grocery.mjs split "milk 2L" "eggs" "bbq sauce" "bread" "chicken"
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const PORT = 19222;
const CHROME_URL = `http://127.0.0.1:${PORT}`;
const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function connectChrome() {
  // Try connecting to existing Chrome
  try {
    return await puppeteer.connect({ browserURL: CHROME_URL, defaultViewport: null });
  } catch {}

  // Chrome not running — auto-launch with saved profile
  console.log('  Starting Chrome with saved profile...');

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium-browser',
  ];

  let chromePath = null;
  for (const p of chromePaths) {
    if (existsSync(p)) { chromePath = p; break; }
  }

  if (!chromePath) {
    console.error('Chrome not found. Install Google Chrome or run: node scripts/chrome-setup.mjs');
    process.exit(1);
  }

  // Check if profile exists (user has run setup)
  if (!existsSync(PROFILE_DIR)) {
    console.error('No saved login found. Run first: node scripts/chrome-setup.mjs');
    process.exit(1);
  }

  // Launch Chrome headless-ish with the saved profile (cookies preserved)
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.woolworths.com.au',
    'https://www.coles.com.au',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  // Wait for Chrome to start
  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try {
      const browser = await puppeteer.connect({ browserURL: CHROME_URL, defaultViewport: null });
      console.log('  Chrome connected with saved session.');
      return browser;
    } catch {}
  }

  console.error('Chrome failed to start. Run: node scripts/chrome-setup.mjs');
  process.exit(1);
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

// ═══════════════════════════════════════════════════════════
// WOOLWORTHS
// ═══════════════════════════════════════════════════════════

async function searchWoolworths(page, query) {
  const response = await page.evaluate(async (q) => {
    const res = await fetch(`https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageSize=5`, {
      headers: { 'Accept': 'application/json' }
    });
    return res.json();
  }, query);

  const products = [];
  if (response.Products) {
    for (const group of response.Products) {
      for (const p of (group.Products || [group])) {
        if (!p.Stockcode) continue;
        products.push({
          name: p.DisplayName || p.Name,
          price: p.Price || p.InstorePrice || null,
          unit: p.PackageSize || '',
          stockcode: p.Stockcode,
          url: `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}`,
          store: 'woolworths'
        });
      }
    }
  }
  return products.slice(0, 5);
}

async function addToCartWoolworths(page, product) {
  // Navigate to the product detail page
  await page.goto(product.url, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Find and click "Add to cart" in shadow DOM
  const clicked = await page.evaluate(() => {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const shadow = el.shadowRoot;
      if (shadow) {
        const btns = shadow.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').toLowerCase();
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('add to cart') || aria.includes('add to cart')) {
            btn.click();
            return true;
          }
        }
      }
    }
    return false;
  });

  await wait(2000);
  return clicked;
}

// ═══════════════════════════════════════════════════════════
// COLES
// ═══════════════════════════════════════════════════════════

async function searchColes(page, query) {
  await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
    waitUntil: 'networkidle2', timeout: 20000
  });
  await wait(4000);

  const products = await page.evaluate(() => {
    const items = [];
    // Coles renders product info as continuous text blocks like:
    // "Coles Full Cream Milk | 2L$3.20$1.60/ 1L5 more buying optionsAdd"
    // We need to parse these intelligently

    // Get all text blocks that contain prices
    const body = document.body.innerText;
    const lines = body.split('\n');

    for (const line of lines) {
      // Look for lines with product patterns: "Name | Size$Price"
      const match = line.match(/^(.+?)\$(\d+\.\d{2})/);
      if (match && match[1].length > 3 && match[1].length < 150) {
        let name = match[1].trim();
        // Clean up name — remove leading badges like "EVERY DAY"
        name = name.replace(/^(EVERY DAY|NEW|HALF PRICE|SPECIAL|Save \$[\d.]+|Life \d+ days min)/gi, '').trim();
        const price = parseFloat(match[2]);

        // Skip if it looks like a unit price line
        if (name.includes('/') && name.length < 10) continue;
        // Skip duplicates
        if (items.some(i => i.name === name)) continue;

        items.push({ name, price, url: null, store: 'coles' });
      }
    }

    // Also try to get product links
    const links = document.querySelectorAll('a[href*="/product/"]');
    for (let i = 0; i < Math.min(links.length, items.length); i++) {
      if (links[i]) items[i].url = links[i].href;
    }

    return items;
  });

  return products.slice(0, 5);
}

async function addToCartColes(page, product) {
  if (product.url) {
    await page.goto(product.url, { waitUntil: 'networkidle2', timeout: 15000 });
  } else {
    await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(product.name)}`, {
      waitUntil: 'networkidle2', timeout: 15000
    });
  }
  await wait(3000);

  const clicked = await page.evaluate(() => {
    // Try buttons
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text.includes('add to cart') || text.includes('add to trolley') || text === 'add' ||
          aria.includes('add to cart') || aria.includes('add to trolley') || aria.includes('add 1')) {
        btn.click();
        return true;
      }
    }
    // Try aria-label on any element
    const ariaEls = document.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      const label = el.getAttribute('aria-label').toLowerCase();
      if ((label.includes('add') && (label.includes('cart') || label.includes('trolley')))) {
        el.click();
        return true;
      }
    }
    return false;
  });

  await wait(2000);
  return clicked;
}

// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

async function compareItems(browser, items) {
  const wPage = await getPage(browser, 'woolworths.com.au');
  const cPage = await getPage(browser, 'coles.com.au');

  console.log(`\n  Comparing ${items.length} items\n`);
  console.log('  ' + 'Item'.padEnd(30) + 'Woolworths'.padEnd(15) + 'Coles'.padEnd(15) + 'Best');
  console.log('  ' + '─'.repeat(70));

  const results = [];

  for (const item of items) {
    const [wProducts, cProducts] = await Promise.all([
      searchWoolworths(wPage, item),
      searchColes(cPage, item)
    ]);

    const w = wProducts[0];
    const c = cProducts[0];
    const wPrice = w?.price || null;
    const cPrice = c?.price || null;

    let best = '—';
    if (wPrice && cPrice) best = wPrice <= cPrice ? 'Woolworths' : 'Coles';
    else if (wPrice) best = 'Woolworths';
    else if (cPrice) best = 'Coles';

    const wStr = wPrice ? `$${wPrice.toFixed(2)}` : 'N/A';
    const cStr = cPrice ? `$${cPrice.toFixed(2)}` : 'N/A';

    console.log(`  ${item.padEnd(30)}${wStr.padEnd(15)}${cStr.padEnd(15)}${best}`);

    results.push({ item, woolworths: w, coles: c, best: best.toLowerCase() });
  }

  return results;
}

async function orderItems(browser, store, items) {
  const domain = store === 'woolworths' ? 'woolworths.com.au' : 'coles.com.au';
  const page = await getPage(browser, domain);
  const searchFn = store === 'woolworths' ? searchWoolworths : searchColes;
  const addFn = store === 'woolworths' ? addToCartWoolworths : addToCartColes;

  console.log(`\n  Adding ${items.length} items to ${store} cart\n`);

  let total = 0;
  let added = 0;

  for (const item of items) {
    process.stdout.write(`  ${item}... `);

    const products = await searchFn(page, item);
    if (products.length === 0) {
      console.log('not found');
      continue;
    }

    const best = products[0];
    const success = await addFn(page, best);

    if (success) {
      console.log(`+ $${best.price?.toFixed(2) || '?'}  ${best.name}`);
      total += best.price || 0;
      added++;
    } else {
      console.log(`! could not add  ${best.name}`);
    }
  }

  console.log(`\n  ${added}/${items.length} items added. Estimated: $${total.toFixed(2)}\n`);
  return { added, total };
}

async function smartSplit(browser, items, minOrder = 50) {
  const results = await compareItems(browser, items);

  let woolies = results.filter(r => r.best === 'woolworths' && r.woolworths);
  let coles = results.filter(r => r.best === 'coles' && r.coles);

  const wTotal = woolies.reduce((s, r) => s + (r.woolworths?.price || 0), 0);
  const cTotal = coles.reduce((s, r) => s + (r.coles?.price || 0), 0);

  if (wTotal > 0 && wTotal < minOrder) {
    console.log(`\n  Woolworths $${wTotal.toFixed(2)} below $${minOrder} min — moving all to Coles`);
    coles = [...coles, ...woolies];
    woolies = [];
  }
  if (cTotal > 0 && cTotal < minOrder) {
    console.log(`\n  Coles $${cTotal.toFixed(2)} below $${minOrder} min — moving all to Woolworths`);
    woolies = [...woolies, ...coles];
    coles = [];
  }

  console.log('\n  ── ORDER SPLIT ──');

  if (woolies.length > 0) {
    console.log(`\n  WOOLWORTHS (${woolies.length} items):`);
    const wPage = await getPage(browser, 'woolworths.com.au');
    let wt = 0;
    for (const r of woolies) {
      process.stdout.write(`    ${r.item}... `);
      const success = await addToCartWoolworths(wPage, r.woolworths);
      console.log(success ? `+ $${r.woolworths.price?.toFixed(2)}` : '! failed');
      wt += r.woolworths.price || 0;
    }
    console.log(`    Total: $${wt.toFixed(2)}`);
  }

  if (coles.length > 0) {
    console.log(`\n  COLES (${coles.length} items):`);
    const cPage = await getPage(browser, 'coles.com.au');
    let ct = 0;
    for (const r of coles) {
      process.stdout.write(`    ${r.item}... `);
      const success = await addToCartColes(cPage, r.coles || { name: r.item });
      console.log(success ? `+ $${r.coles?.price?.toFixed(2) || '?'}` : '! failed');
      ct += r.coles?.price || 0;
    }
    console.log(`    Total: $${ct.toFixed(2)}`);
  }

  console.log('');
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.log(`
  Grocery — Woolworths & Coles

  compare <item1> <item2> ...              Compare prices
  order woolworths <item1> <item2> ...     Add to Woolworths cart
  order coles <item1> <item2> ...          Add to Coles cart
  split <item1> <item2> ...               Smart split (cheapest per item)
  `);
  process.exit(0);
}

const browser = await connectChrome();

try {
  switch (command) {
    case 'compare':
      await compareItems(browser, args);
      break;

    case 'order': {
      const store = args[0];
      await orderItems(browser, store, args.slice(1));
      break;
    }

    case 'split':
      await smartSplit(browser, args);
      break;

    default:
      console.log(`Unknown: ${command}`);
  }
} finally {
  browser.disconnect();
}
