#!/usr/bin/env node

/**
 * GROCERY BUY — end-to-end grocery ordering.
 * No AI needed. No human clicks needed. Groceries at your door.
 *
 * This script:
 *   1. Connects to your logged-in Chrome
 *   2. Clears the cart
 *   3. Searches and adds every item
 *   4. Opens checkout
 *   5. Selects earliest delivery (ASAP / Rapid)
 *   6. Sets delivery instructions (leave at door)
 *   7. Confirms and pays
 *
 * Usage:
 *   node scripts/grocery-buy.mjs woolworths "milk 2L" "eggs 12" "bread"
 *   node scripts/grocery-buy.mjs coles "milk 2L" "eggs 12" "bread"
 *   node scripts/grocery-buy.mjs auto "milk 2L" "eggs 12" "bread"   ← cheapest store
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import { readFileSync } from 'fs';

const PORT = 19222;
const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
const PREFS_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-preferences.json');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Load config
let PREFS = {};
try { PREFS = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')); } catch {}
const CVV = PREFS.payment?.cvv || null;
const DELIVERY_INSTRUCTIONS = PREFS.delivery?.instructions || 'Please leave at front door / pouch. Thank you.';
const MIN_ORDER_WOOLWORTHS = 75;
const MIN_ORDER_COLES = 50;

// ═══════════════════════════════════════════════════════════
// CHROME
// ═══════════════════════════════════════════════════════════

async function connectChrome() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {}

  if (!existsSync(PROFILE_DIR)) {
    console.error('No saved login. Run: gombwe grocery-setup');
    process.exit(1);
  }

  const chromePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find(p => existsSync(p));

  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }

  spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.woolworths.com.au',
    'https://www.coles.com.au',
  ], { detached: true, stdio: 'ignore' }).unref();

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
    await wait(3000);
  }
  return page;
}

// ═══════════════════════════════════════════════════════════
// WOOLWORTHS — FULL BUY FLOW
// ═══════════════════════════════════════════════════════════

async function woolworthsSearch(page, query) {
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
          stockcode: p.Stockcode,
          url: `https://www.woolworths.com.au/shop/productdetails/${p.Stockcode}`,
        });
      }
    }
  }
  return products.slice(0, 5);
}

async function woolworthsAddToCart(page, product) {
  await page.goto(product.url, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(4000);

  return await page.evaluate((name) => {
    function find(root, depth = 0) {
      if (depth > 3) return null;
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (el.shadowRoot) {
          const btns = el.shadowRoot.querySelectorAll('button');
          for (const btn of btns) {
            const text = (btn.textContent || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if ((text.includes('add to cart') || aria.includes('add to cart')) &&
                (name ? aria.includes(name.toLowerCase().slice(0, 15)) : true)) {
              btn.click();
              return true;
            }
          }
          const nested = find(el.shadowRoot, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    }
    return find(document) || false;
  }, product.name);
}

async function woolworthsClearCart(page) {
  await page.goto('https://www.woolworths.com.au/shop/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  for (let i = 0; i < 30; i++) {
    const removed = await page.evaluate(() => {
      function find(root, depth = 0) {
        if (depth > 3) return false;
        const els = root.querySelectorAll('*');
        for (const el of els) {
          if (el.shadowRoot) {
            const btns = el.shadowRoot.querySelectorAll('button');
            for (const btn of btns) {
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (aria.includes('remove') || aria.includes('delete')) {
                btn.click();
                return true;
              }
            }
            if (find(el.shadowRoot, depth + 1)) return true;
          }
        }
        // Non-shadow buttons
        const buttons = root.querySelectorAll('button');
        for (const btn of buttons) {
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('remove from cart') || aria.includes('remove item')) {
            btn.click();
            return true;
          }
        }
        return false;
      }
      return find(document);
    });
    if (!removed) break;
    await wait(1500);
  }
}

async function woolworthsCheckoutAndPay(page) {
  // Go to cart
  await page.goto('https://www.woolworths.com.au/shop/cart', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  // Get cart info
  const cartTotal = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/\$(\d+\.\d{2})\s*(in total|total|estimated)/i);
    return match ? match[1] : null;
  });

  console.log(`  Cart total: $${cartTotal || '?'}`);

  // Click checkout — search shadow DOM
  await page.evaluate(() => {
    function find(root, depth = 0) {
      if (depth > 3) return;
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (el.shadowRoot) {
          const btns = el.shadowRoot.querySelectorAll('button, a');
          for (const btn of btns) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('checkout') || text.includes('check out')) {
              btn.click();
              return true;
            }
          }
          if (find(el.shadowRoot, depth + 1)) return true;
        }
      }
      // Non-shadow
      const buttons = root.querySelectorAll('button, a');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        const href = (btn.getAttribute('href') || '').toLowerCase();
        if (text.includes('checkout') || href.includes('checkout')) {
          btn.click();
          return true;
        }
      }
    }
    find(document);
  });

  await wait(8000);

  // Try to navigate directly if the button didn't work
  if (!page.url().includes('checkout')) {
    await page.goto('https://www.woolworths.com.au/shop/checkout', { waitUntil: 'networkidle2', timeout: 15000 });
    await wait(5000);
  }

  // Select earliest delivery time
  console.log('  Selecting delivery time...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, [role=button], label, div');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if ((text.includes('earliest') || text.includes('asap') || text.includes('soonest') ||
           text.includes('first available')) && text.length < 100) {
        btn.click();
        return;
      }
    }
    // Click first available time slot
    const slots = document.querySelectorAll('[class*=slot], [class*=time]');
    for (const slot of slots) {
      if (!slot.textContent.toLowerCase().includes('unavailable') &&
          !slot.textContent.toLowerCase().includes('sold out')) {
        slot.click();
        return;
      }
    }
  });
  await wait(3000);

  // Set delivery instructions
  await page.evaluate((instructions) => {
    const inputs = document.querySelectorAll('input, textarea');
    for (const input of inputs) {
      const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') || '').toLowerCase();
      if (label.includes('instruction') || label.includes('note') || label.includes('delivery')) {
        input.value = instructions;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, DELIVERY_INSTRUCTIONS);

  await wait(2000);

  // Enter CVV if required
  if (CVV) {
    console.log('  Entering payment CVV...');
    await page.evaluate((cvv) => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') ||
                       input.getAttribute('name') || input.id || '').toLowerCase();
        const type = input.type || '';
        if (label.includes('cvv') || label.includes('cvc') || label.includes('security code') ||
            label.includes('card verification') || (type === 'password' && label.includes('card')) ||
            (type === 'tel' && input.maxLength <= 4 && input.maxLength >= 3)) {
          input.value = cvv;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // Also check shadow DOM for CVV input
      function findCvv(root, depth = 0) {
        if (depth > 3) return;
        const els = root.querySelectorAll('*');
        for (const el of els) {
          if (el.shadowRoot) {
            const inputs = el.shadowRoot.querySelectorAll('input');
            for (const input of inputs) {
              const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') || '').toLowerCase();
              if (label.includes('cvv') || label.includes('cvc') || label.includes('security')) {
                input.value = cvv;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            findCvv(el.shadowRoot, depth + 1);
          }
        }
      }
      findCvv(document);
    }, CVV);
    await wait(2000);
  }

  // Click Place Order / Pay / Confirm
  console.log('  Placing order...');
  const ordered = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('place order') || text.includes('confirm order') ||
          text.includes('pay now') || text.includes('complete order') ||
          text.includes('submit order')) {
        btn.click();
        return btn.textContent.trim();
      }
    }
    return null;
  });

  if (ordered) {
    console.log(`  Order placed: ${ordered}`);
    await wait(5000);
  } else {
    console.log('  Could not auto-place order. Check Chrome.');
    console.log('  URL:', page.url());
  }

  return { total: cartTotal, ordered: !!ordered };
}

// ═══════════════════════════════════════════════════════════
// COLES — FULL BUY FLOW
// ═══════════════════════════════════════════════════════════

async function colesSearch(page, query) {
  await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, {
    waitUntil: 'networkidle2', timeout: 20000
  });
  await wait(4000);

  return await page.evaluate(() => {
    const items = [];
    const tiles = document.querySelectorAll('[data-testid="product-tile"], section');
    for (const tile of tiles) {
      const titleEl = tile.querySelector('[data-testid="product-title"], h2, h3');
      if (!titleEl) continue;
      const name = titleEl.textContent.trim();
      if (!name || name.length < 3) continue;

      const priceEl = tile.querySelector('[data-testid="product-pricing"] .price__value, .price__value');
      let price = null;
      if (priceEl) {
        const match = priceEl.textContent.match(/\$(\d+\.\d{2})/);
        if (match) price = parseFloat(match[1]);
      }

      const linkEl = tile.querySelector('a[href*="/product/"]');
      items.push({ name, price, url: linkEl?.href || null, store: 'coles' });
    }
    return items;
  });
}

async function colesAddToCart(page, product) {
  const url = product.url || `https://www.coles.com.au/search/products?q=${encodeURIComponent(product.name)}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(3000);

  return await page.evaluate(() => {
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
    return false;
  });
}

async function colesClearCart(page) {
  await page.goto('https://www.coles.com.au', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(2000);

  // Open trolley
  await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
  await wait(3000);

  // Remove items
  for (let i = 0; i < 30; i++) {
    const removed = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('remove') || (text === 'remove' && btn.closest('[class*=trolley], [class*=cart]'))) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!removed) break;
    await wait(1500);

    // Confirm if dialog
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'remove' || text === 'yes' || text === 'confirm') btn.click();
      }
    });
    await wait(1000);
  }
}

async function colesCheckoutAndPay(page) {
  const log = [];
  const step = (msg) => { console.log(`  ${msg}`); log.push(msg); };

  // STEP 1: Go to Coles home, open trolley
  step('Opening trolley...');
  await page.goto('https://www.coles.com.au', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(2000);

  const total = await page.evaluate(() => {
    return document.querySelector('[data-testid="header-trolley"]')?.textContent?.match(/\$([\d.]+)/)?.[1] || null;
  });
  step(`Trolley total: $${total || '?'}`);

  await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
  await wait(3000);

  // STEP 2: Dismiss expired slot if shown
  const expired = await page.evaluate(() => {
    const text = document.body.innerText;
    if (text.includes('no longer available') || text.includes('expired')) {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Pick a new slot'));
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (expired) { step('Dismissed expired slot'); await wait(3000); }

  // STEP 3: Select delivery time — click "As soon as possible" tab
  step('Selecting ASAP delivery...');
  await page.evaluate(() => {
    const els = document.querySelectorAll('button, div, label');
    for (const el of els) {
      if (el.textContent.trim() === 'As soon as possible' && el.children.length <= 3) {
        el.click(); return;
      }
    }
  });
  await wait(2000);

  // STEP 4: Click the ETA radio button (the circle, using coordinates relative to "ETA" text)
  step('Clicking ETA delivery slot...');
  const etaPos = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.includes('ETA') && node.textContent.includes('min')) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, h: rect.height };
      }
    }
    return null;
  });

  if (etaPos) {
    await page.mouse.click(etaPos.x - 20, etaPos.y + etaPos.h / 2);
    step('Selected ETA slot');
    await wait(3000);
  } else {
    step('WARNING: ETA slot not found');
  }

  // STEP 5: Click "Confirm" (red button that appears after selecting slot)
  step('Confirming delivery slot...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'Confirm') { btn.click(); return; }
    }
  });
  await wait(3000);

  // STEP 6: Click "Continue" (appears after confirm, shows trolley summary)
  step('Continuing...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'Continue') { btn.click(); return; }
    }
  });
  await wait(3000);

  // STEP 7: Click "Checkout" (red button at bottom of trolley)
  step('Clicking Checkout...');
  await page.evaluate(() => document.querySelector('[data-testid="checkout"]')?.click());
  await wait(5000);

  // STEP 8: Dismiss "Missing anything?" upsell page
  step('Dismissing upsell...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('Continue to checkout')) { btn.click(); return; }
    }
  });
  await wait(8000);

  // STEP 9: Handle expired slot (if took too long)
  const expired2 = await page.evaluate(() => {
    if (document.body.innerText.includes('no longer available')) {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Pick a new slot'));
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (expired2) {
    step('Slot expired during checkout — re-selecting...');
    await wait(3000);
    // Re-do steps 3-8
    await page.evaluate(() => {
      const els = document.querySelectorAll('button, div');
      for (const el of els) {
        if (el.textContent.trim() === 'As soon as possible' && el.children.length <= 3) {
          el.click(); return;
        }
      }
    });
    await wait(2000);
    if (etaPos) await page.mouse.click(etaPos.x - 20, etaPos.y + etaPos.h / 2);
    await wait(2000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button'));
      b.find(x => x.textContent.trim() === 'Confirm')?.click();
    });
    await wait(2000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button'));
      b.find(x => x.textContent.trim() === 'Continue')?.click();
    });
    await wait(2000);
    await page.evaluate(() => document.querySelector('[data-testid="checkout"]')?.click());
    await wait(3000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button'));
      b.find(x => x.textContent.includes('Continue to checkout'))?.click();
    });
    await wait(8000);
  }

  // STEP 10: We should now be on the payment/review page
  step('On payment page...');
  await page.screenshot({ path: '/tmp/coles-payment-page.png' });

  // STEP 11: Enter CVV
  if (CVV) {
    step('Entering CVV...');
    // CVV might be in an iframe (payment processors often use iframes)
    const frames = page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate((cvv) => {
          const inputs = document.querySelectorAll('input');
          for (const input of inputs) {
            const label = (input.getAttribute('aria-label') || input.placeholder ||
                           input.name || input.id || '').toLowerCase();
            const ml = input.maxLength;
            if (label.includes('cvv') || label.includes('cvc') || label.includes('security') ||
                label.includes('card verification') || (ml >= 3 && ml <= 4 && input.type === 'tel')) {
              input.focus();
              input.value = cvv;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }, CVV);
      } catch {}
    }
    await wait(2000);
  }

  // STEP 12: Click Place Order
  step('Placing order...');
  const ordered = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase().trim();
      const testid = btn.getAttribute('data-testid') || '';
      if (text.includes('place order') || text.includes('confirm order') ||
          text.includes('pay now') || text.includes('complete order') ||
          text.includes('submit order') || testid.includes('place-order') ||
          testid.includes('submit') || testid.includes('confirm-order')) {
        btn.click();
        return btn.textContent.trim();
      }
    }
    return null;
  });

  if (ordered) {
    step(`ORDER PLACED: ${ordered}`);
    await wait(5000);
  } else {
    await page.screenshot({ path: '/tmp/coles-final.png' });
    step('FAILED: Could not find Place Order button. Screenshot: /tmp/coles-final.png');
  }

  // Write log for AI monitoring
  const logReport = {
    store: 'coles',
    total,
    steps: log,
    success: !!ordered,
    timestamp: new Date().toISOString()
  };

  try {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(homedir(), '.claude-gombwe', 'data', 'grocery-last-run.json'), JSON.stringify(logReport, null, 2));
  } catch {}

  return { total, ordered: !!ordered, log };
}

// ═══════════════════════════════════════════════════════════
// FULL BUY — the one function the skill calls
// ═══════════════════════════════════════════════════════════

async function buy(store, items) {
  const browser = await connectChrome();

  try {
    if (store === 'auto') {
      // Compare and pick cheapest
      console.log(`\n  Comparing prices for ${items.length} items...\n`);

      const wPage = await getPage(browser, 'woolworths.com.au');
      const cPage = await getPage(browser, 'coles.com.au');

      let wTotal = 0, cTotal = 0;
      for (const item of items) {
        const wProducts = await woolworthsSearch(wPage, item);
        const cProducts = await colesSearch(cPage, item);
        const wPrice = wProducts[0]?.price || 999;
        const cPrice = cProducts[0]?.price || 999;
        wTotal += wPrice === 999 ? 0 : wPrice;
        cTotal += cPrice === 999 ? 0 : cPrice;
        const best = wPrice <= cPrice ? 'W' : 'C';
        console.log(`  ${item.padEnd(35)} W: $${wPrice === 999 ? '?' : wPrice.toFixed(2).padEnd(8)} C: $${cPrice === 999 ? '?' : cPrice.toFixed(2).padEnd(8)} ${best}`);
      }

      store = wTotal <= cTotal ? 'woolworths' : 'coles';
      console.log(`\n  Woolworths: $${wTotal.toFixed(2)} | Coles: $${cTotal.toFixed(2)}`);
      console.log(`  → Ordering from ${store}\n`);
    }

    const page = await getPage(browser, store === 'woolworths' ? 'woolworths.com.au' : 'coles.com.au');
    const searchFn = store === 'woolworths' ? woolworthsSearch : colesSearch;
    const addFn = store === 'woolworths' ? woolworthsAddToCart : colesAddToCart;
    const clearFn = store === 'woolworths' ? woolworthsClearCart : colesClearCart;
    const checkoutFn = store === 'woolworths' ? woolworthsCheckoutAndPay : colesCheckoutAndPay;

    // 1. Clear cart
    console.log(`  Clearing ${store} cart...`);
    await clearFn(page);
    console.log('  Cart cleared.\n');

    // 2. Add items
    console.log(`  Adding ${items.length} items:\n`);
    let total = 0;
    let added = 0;

    for (const item of items) {
      process.stdout.write(`  ${item}... `);
      const products = await searchFn(page, item);
      if (products.length === 0) { console.log('not found'); continue; }

      const best = products[0];
      await wait(1000);
      const success = await addFn(page, best);

      if (success) {
        console.log(`+ $${best.price?.toFixed(2) || '?'}  ${best.name}`);
        total += best.price || 0;
        added++;
      } else {
        console.log(`! could not add  ${best.name}`);
      }
      await wait(500);
    }

    console.log(`\n  ${added}/${items.length} items added. Estimated: $${total.toFixed(2)}\n`);

    if (added === 0) {
      console.log('  No items added. Aborting checkout.');
      return;
    }

    const minOrder = store === 'woolworths' ? MIN_ORDER_WOOLWORTHS : MIN_ORDER_COLES;
    if (total < minOrder) {
      console.log(`  Warning: $${total.toFixed(2)} below $${minOrder} ${store} delivery minimum.`);
      console.log('  Delivery fee may apply.\n');
    }

    // 3. Checkout and pay
    console.log('  ── CHECKOUT ──\n');
    const result = await checkoutFn(page);

    if (result.ordered) {
      console.log(`\n  ORDER CONFIRMED`);
      console.log(`  Store: ${store}`);
      console.log(`  Items: ${added}`);
      console.log(`  Total: $${result.total || total.toFixed(2)}`);
      console.log(`  Delivery: ASAP`);
      console.log(`  Instructions: ${DELIVERY_INSTRUCTIONS}`);
      console.log(`\n  Groceries are on their way!\n`);
    }

  } finally {
    browser.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const [store, ...items] = process.argv.slice(2);

if (!store || items.length === 0) {
  console.log(`
  grocery-buy — Delivered groceries, zero clicks.

  Usage:
    node grocery-buy.mjs auto "milk 2L" "eggs" "bread"     Compare & buy cheapest
    node grocery-buy.mjs woolworths "milk 2L" "eggs"        Buy from Woolworths
    node grocery-buy.mjs coles "milk 2L" "eggs"             Buy from Coles
  `);
  process.exit(0);
}

if (!['auto', 'woolworths', 'coles'].includes(store)) {
  console.error(`Unknown store: ${store}. Use: auto, woolworths, or coles`);
  process.exit(1);
}

buy(store, items).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
