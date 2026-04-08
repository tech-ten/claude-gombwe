#!/usr/bin/env node

/**
 * Grocery automation — search, compare, cart, checkout at Woolworths & Coles.
 *
 * Commands:
 *   compare <items...>                    Compare prices
 *   order woolworths|coles <items...>     Add to cart at one store
 *   split <items...>                      Smart split across both
 *   checkout woolworths|coles             Pick earliest delivery, leave at door
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { findChrome, detachedSpawnOptions } from './platform.mjs';

const PORT = 19222;
const CHROME_URL = `http://127.0.0.1:${PORT}`;
const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
const MIN_ORDER = 50;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function connectChrome() {
  try {
    return await puppeteer.connect({ browserURL: CHROME_URL, defaultViewport: null });
  } catch {}

  console.log('  Starting Chrome with saved profile...');

  const chromePath = findChrome();
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }
  if (!existsSync(PROFILE_DIR)) { console.error('Run gombwe grocery-setup first.'); process.exit(1); }

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.woolworths.com.au',
    'https://www.coles.com.au',
  ], detachedSpawnOptions());
  chrome.unref();

  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try { return await puppeteer.connect({ browserURL: CHROME_URL, defaultViewport: null }); } catch {}
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

// ═══════════════════════════════════════════════════════════
// WOOLWORTHS — uses internal API (reliable prices)
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

async function clearWoolworthsCart(page) {
  await page.goto('https://www.woolworths.com.au/shop/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Keep clicking remove buttons until cart is empty
  for (let i = 0; i < 30; i++) {
    const removed = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        const shadow = el.shadowRoot;
        if (shadow) {
          const btns = shadow.querySelectorAll('button');
          for (const btn of btns) {
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = (btn.textContent || '').toLowerCase();
            if (aria.includes('remove') || aria.includes('delete') || text.includes('remove')) {
              btn.click();
              return true;
            }
          }
        }
      }
      // Also try non-shadow buttons
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('remove from cart') || aria.includes('remove item')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!removed) break;
    await wait(1500);
  }
}

async function clearColesCart(page) {
  await page.goto('https://www.coles.com.au/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Click "Empty trolley" or remove items one by one
  for (let i = 0; i < 30; i++) {
    const removed = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('remove') || aria.includes('remove') || text.includes('delete')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!removed) break;
    await wait(1500);

    // Confirm removal if a dialog appears
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text === 'remove' || text === 'yes' || text === 'confirm') {
          btn.click();
        }
      }
    });
    await wait(1000);
  }
}

async function addToCartWoolworths(page, product) {
  await page.goto(product.url, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(4000);

  const clicked = await page.evaluate((productName) => {
    // Deep shadow DOM search — Woolworths nests buttons inside WC-ADD-TO-CART shadow roots
    function findAddButton(root, depth = 0) {
      if (depth > 3) return null;
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (el.shadowRoot) {
          const btns = el.shadowRoot.querySelectorAll('button');
          for (const btn of btns) {
            const text = (btn.textContent || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            // Match the specific product to avoid adding wrong items
            const nameMatch = productName ? aria.includes(productName.toLowerCase().slice(0, 20)) : true;
            if ((text.includes('add to cart') || aria.includes('add to cart')) && nameMatch) {
              return btn;
            }
          }
          // Recurse into nested shadow roots
          const nested = findAddButton(el.shadowRoot, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    }

    const btn = findAddButton(document);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, product.name);

  await wait(2000);
  return clicked;
}

// ═══════════════════════════════════════════════════════════
// COLES — search page for names, add to cart, read price from trolley
// ═══════════════════════════════════════════════════════════

async function searchColes(page, query) {
  await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
    waitUntil: 'networkidle2', timeout: 20000
  });
  await wait(4000);

  const products = await page.evaluate(() => {
    const items = [];

    // Coles has clean DOM: data-testid="product-pricing" with class "price__value" for pack price
    // and "price__calculation_method" for unit price. We want the pack price.
    const tiles = document.querySelectorAll('[data-testid="product-tile"], section');

    for (const tile of tiles) {
      // Product name
      const titleEl = tile.querySelector('[data-testid="product-title"], h2, h3');
      if (!titleEl) continue;
      const name = titleEl.textContent.trim();
      if (!name || name.length < 3) continue;

      // Pack price (not unit price)
      const priceEl = tile.querySelector('[data-testid="product-pricing"] .price__value, .price__value');
      let price = null;
      if (priceEl) {
        const match = priceEl.textContent.match(/\$(\d+\.\d{2})/);
        if (match) price = parseFloat(match[1]);
      }

      // Product link
      const linkEl = tile.querySelector('a[href*="/product/"]');
      const url = linkEl ? linkEl.href : null;

      items.push({ name, price, url, store: 'coles' });
    }

    // Fallback if no tiles found — use aria-label on pricing elements
    if (items.length === 0) {
      const pricingEls = document.querySelectorAll('[data-testid="product-pricing"]');
      const titleEls = document.querySelectorAll('[data-testid="product-title"]');
      const linkEls = document.querySelectorAll('a[href*="/product/"]');

      for (let i = 0; i < Math.min(pricingEls.length, titleEls.length); i++) {
        const name = titleEls[i]?.textContent?.trim();
        const ariaPrice = pricingEls[i]?.getAttribute('aria-label'); // "Price $3.20"
        let price = null;
        if (ariaPrice) {
          const match = ariaPrice.match(/\$(\d+\.\d{2})/);
          if (match) price = parseFloat(match[1]);
        }
        const url = linkEls[i]?.href || null;
        if (name) items.push({ name, price, url, store: 'coles' });
      }
    }

    return items;
  });

  return products.slice(0, 5);
}

async function addToCartColes(page, product) {
  const url = product.url || `https://www.coles.com.au/search/products?q=${encodeURIComponent(product.name)}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  const clicked = await page.evaluate(() => {
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
    const ariaEls = document.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      const label = el.getAttribute('aria-label').toLowerCase();
      if (label.includes('add') && (label.includes('cart') || label.includes('trolley'))) {
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
// CHECKOUT — pick earliest delivery, leave at door
// ═══════════════════════════════════════════════════════════

async function checkoutWoolworths(page) {
  console.log('\n  Checking out Woolworths...\n');

  // Go to cart
  await page.goto('https://www.woolworths.com.au/shop/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Get cart total
  const cartInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const totalMatch = text.match(/\$(\d+\.\d{2})\s*(in total|total|estimated)/i);
    const itemMatch = text.match(/(\d+)\s*item/i);
    return {
      total: totalMatch ? totalMatch[1] : null,
      items: itemMatch ? itemMatch[1] : null
    };
  });

  if (cartInfo.total) console.log(`  Cart: ${cartInfo.items || '?'} items, $${cartInfo.total}`);

  // Click checkout
  const checkoutClicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a');
    for (const btn of btns) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('checkout') || text.includes('check out')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!checkoutClicked) {
    console.log('  Could not find checkout button. Please complete checkout manually.');
    console.log('  Cart: https://www.woolworths.com.au/shop/cart');
    return;
  }

  await wait(5000);

  // Select earliest delivery time
  console.log('  Selecting earliest delivery time...');
  const timeSelected = await page.evaluate(() => {
    // Look for the first available delivery time slot
    const slots = document.querySelectorAll('button[class*="time"], [class*="slot"], [class*="timeslot"]');
    for (const slot of slots) {
      const text = slot.textContent.toLowerCase();
      if (!text.includes('unavailable') && !text.includes('sold out')) {
        slot.click();
        return slot.textContent.trim();
      }
    }
    return null;
  });

  if (timeSelected) console.log(`  Selected: ${timeSelected}`);
  else console.log('  Could not auto-select time. Please choose manually.');

  // Set delivery instructions — leave at door
  console.log('  Setting delivery instructions: Leave at front door/pouch');
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, textarea');
    for (const input of inputs) {
      const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') || '').toLowerCase();
      if (label.includes('instruction') || label.includes('note') || label.includes('delivery')) {
        input.value = 'Please leave at front door / pouch. Thank you.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  console.log('\n  Checkout ready. Review in Chrome and confirm payment.');
  console.log('  Cart: https://www.woolworths.com.au/shop/checkout\n');
}

async function checkoutColes(page) {
  console.log('\n  Checking out Coles...\n');

  // Go to trolley
  await page.goto('https://www.coles.com.au/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Get trolley total
  const cartInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const totalMatch = text.match(/\$(\d+\.\d{2})/);
    const itemMatch = text.match(/(\d+)\s*item/i);
    return {
      total: totalMatch ? totalMatch[1] : null,
      items: itemMatch ? itemMatch[1] : null
    };
  });

  if (cartInfo.total) console.log(`  Trolley: ${cartInfo.items || '?'} items, $${cartInfo.total}`);

  // Click checkout
  const checkoutClicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a');
    for (const btn of btns) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('checkout') || text.includes('check out')) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!checkoutClicked) {
    console.log('  Could not find checkout button. Please complete checkout manually.');
    console.log('  Trolley: https://www.coles.com.au/cart');
    return;
  }

  await wait(5000);

  // Select earliest delivery time
  console.log('  Selecting earliest delivery time...');
  const timeSelected = await page.evaluate(() => {
    const slots = document.querySelectorAll('button[class*="time"], [class*="slot"], [class*="timeslot"]');
    for (const slot of slots) {
      const text = slot.textContent.toLowerCase();
      if (!text.includes('unavailable') && !text.includes('sold out')) {
        slot.click();
        return slot.textContent.trim();
      }
    }
    return null;
  });

  if (timeSelected) console.log(`  Selected: ${timeSelected}`);
  else console.log('  Could not auto-select time. Please choose manually.');

  // Set delivery instructions
  console.log('  Setting delivery instructions: Leave at front door/pouch');
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, textarea');
    for (const input of inputs) {
      const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') || '').toLowerCase();
      if (label.includes('instruction') || label.includes('note') || label.includes('delivery')) {
        input.value = 'Please leave at front door / pouch. Thank you.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  console.log('\n  Checkout ready. Review in Chrome and confirm payment.');
  console.log('  Trolley: https://www.coles.com.au/cart\n');
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
    const wProducts = await searchWoolworths(wPage, item);
    const cProducts = await searchColes(cPage, item);

    const w = wProducts[0];
    const c = cProducts[0];
    const wPrice = w?.price || null;
    const cPrice = c?.price || null;

    let best = '—';
    if (wPrice && cPrice) best = wPrice <= cPrice ? 'Woolworths' : 'Coles';
    else if (wPrice) best = 'Woolworths';
    else if (cPrice) best = 'Coles';

    console.log(`  ${item.padEnd(30)}${(wPrice ? `$${wPrice.toFixed(2)}` : 'N/A').padEnd(15)}${(cPrice ? `$${cPrice.toFixed(2)}` : 'N/A').padEnd(15)}${best}`);

    results.push({ item, woolworths: w, coles: c, best: best.toLowerCase(), wPrice, cPrice });
  }

  return results;
}

async function orderItems(browser, store, items, doCheckout = false) {
  const domain = store === 'woolworths' ? 'woolworths.com.au' : 'coles.com.au';
  const page = await getPage(browser, domain);
  const searchFn = store === 'woolworths' ? searchWoolworths : searchColes;
  const addFn = store === 'woolworths' ? addToCartWoolworths : addToCartColes;

  // Clear cart before starting fresh
  console.log(`\n  Clearing ${store} cart...`);
  if (store === 'woolworths') await clearWoolworthsCart(page);
  else await clearColesCart(page);
  console.log('  Cart cleared.');

  console.log(`\n  Adding ${items.length} items to ${store} cart\n`);

  let total = 0;
  let added = 0;

  for (const item of items) {
    process.stdout.write(`  ${item}... `);
    const products = await searchFn(page, item);
    if (products.length === 0) { console.log('not found'); continue; }

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

  console.log(`\n  ${added}/${items.length} items added. Estimated: $${total.toFixed(2)}`);

  if (doCheckout) {
    if (store === 'woolworths') await checkoutWoolworths(page);
    else await checkoutColes(page);
  }

  return { added, total };
}

async function smartSplit(browser, items, doCheckout = false) {
  const results = await compareItems(browser, items);

  // Calculate totals per store
  let wItems = results.filter(r => r.best === 'woolworths' && r.woolworths);
  let cItems = results.filter(r => r.best === 'coles' && r.coles);
  const noMatch = results.filter(r => r.best === '—');

  // Items with no price at either store — default to woolworths
  for (const r of noMatch) {
    if (r.woolworths) wItems.push(r);
    else if (r.coles) cItems.push(r);
  }

  let wTotal = wItems.reduce((s, r) => s + (r.wPrice || 0), 0);
  let cTotal = cItems.reduce((s, r) => s + (r.cPrice || 0), 0);
  const grandTotal = wTotal + cTotal;

  console.log(`\n  Woolworths total: $${wTotal.toFixed(2)}`);
  console.log(`  Coles total: $${cTotal.toFixed(2)}`);
  console.log(`  Combined: $${grandTotal.toFixed(2)}`);

  // Decision logic
  const bothAboveMin = wTotal >= MIN_ORDER && cTotal >= MIN_ORDER;

  if (bothAboveMin) {
    // Both orders qualify for free delivery — split is optimal
    console.log(`\n  Both above $${MIN_ORDER} minimum — splitting for best prices`);
  } else if (grandTotal < MIN_ORDER * 2) {
    // Total doesn't justify two orders — pick the cheapest store overall
    // Calculate what all items would cost at each store
    const allAtW = results.reduce((s, r) => s + (r.wPrice || r.cPrice || 0), 0);
    const allAtC = results.reduce((s, r) => s + (r.cPrice || r.wPrice || 0), 0);

    const cheaperStore = allAtW <= allAtC ? 'woolworths' : 'coles';
    console.log(`\n  Total $${grandTotal.toFixed(2)} doesn't justify two deliveries`);
    console.log(`  All at Woolworths: $${allAtW.toFixed(2)}`);
    console.log(`  All at Coles: $${allAtC.toFixed(2)}`);
    console.log(`  → Ordering everything from ${cheaperStore}`);

    if (cheaperStore === 'woolworths') {
      wItems = results.filter(r => r.woolworths);
      cItems = [];
    } else {
      cItems = results.filter(r => r.coles);
      wItems = [];
    }
  } else {
    // One store is below minimum — move its items to the other
    if (wTotal < MIN_ORDER && wTotal > 0) {
      console.log(`\n  Woolworths $${wTotal.toFixed(2)} below $${MIN_ORDER} — moving to Coles`);
      cItems = [...cItems, ...wItems];
      wItems = [];
    }
    if (cTotal < MIN_ORDER && cTotal > 0) {
      console.log(`\n  Coles $${cTotal.toFixed(2)} below $${MIN_ORDER} — moving to Woolworths`);
      wItems = [...wItems, ...cItems];
      cItems = [];
    }
  }

  // Clear carts before ordering
  console.log('\n  ── ORDER ──');

  if (wItems.length > 0) {
    const wPage = await getPage(browser, 'woolworths.com.au');
    console.log('\n  Clearing Woolworths cart...');
    await clearWoolworthsCart(wPage);
    console.log(`  WOOLWORTHS (${wItems.length} items):`);

    let wt = 0;
    for (const r of wItems) {
      process.stdout.write(`    ${r.item}... `);
      const success = await addToCartWoolworths(wPage, r.woolworths || r.coles);
      const price = r.woolworths?.price || r.coles?.price || 0;
      console.log(success ? `+ $${price.toFixed(2)}` : '! failed');
      wt += price;
    }
    console.log(`    Total: $${wt.toFixed(2)}`);

    if (doCheckout) await checkoutWoolworths(wPage);
  }

  if (cItems.length > 0) {
    const cPage = await getPage(browser, 'coles.com.au');
    console.log('\n  Clearing Coles cart...');
    await clearColesCart(cPage);
    console.log(`  COLES (${cItems.length} items):`);

    let ct = 0;
    for (const r of cItems) {
      process.stdout.write(`    ${r.item}... `);
      const success = await addToCartColes(cPage, r.coles || { name: r.item });
      const price = r.coles?.price || r.woolworths?.price || 0;
      console.log(success ? `+ $${price.toFixed(2)}` : '! failed');
      ct += price;
    }
    console.log(`    Total: $${ct.toFixed(2)}`);

    if (doCheckout) await checkoutColes(cPage);
  }

  console.log('');
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const allArgs = process.argv.slice(2);
const doCheckout = allArgs.includes('--checkout');
const args = allArgs.filter(a => a !== '--checkout');
const [command, ...items] = args;

if (!command) {
  console.log(`
  Grocery — Woolworths & Coles

  compare <items...>                      Compare prices
  order woolworths|coles <items...>       Add to cart
  split <items...>                        Smart split across both
  checkout woolworths|coles               Checkout — earliest delivery, leave at door

  Add --checkout to any order/split command to auto-checkout after adding items.
  `);
  process.exit(0);
}

const browser = await connectChrome();

try {
  switch (command) {
    case 'compare':
      await compareItems(browser, items);
      break;
    case 'order': {
      const store = items[0];
      await orderItems(browser, store, items.slice(1), doCheckout);
      break;
    }
    case 'split':
      await smartSplit(browser, items, doCheckout);
      break;
    case 'checkout': {
      const store = items[0];
      const page = await getPage(browser, store === 'coles' ? 'coles.com.au' : 'woolworths.com.au');
      if (store === 'coles') await checkoutColes(page);
      else await checkoutWoolworths(page);
      break;
    }
    default:
      console.log(`Unknown: ${command}`);
  }
} finally {
  browser.disconnect();
}
