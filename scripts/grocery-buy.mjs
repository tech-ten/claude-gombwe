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
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { findChrome, detachedSpawnOptions, tempPath } from './platform.mjs';

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
const PRICE_LIMITS = PREFS.price_limits || {};
const PRICE_BUFFER = 1.15; // 15% buffer above listed limits
const CLEAR_CACHE = PREFS.clear_cache_before_order !== false; // default true

/**
 * Pick the best product from search results, respecting price limits.
 * Prefers the cheapest product that is under the limit (with buffer).
 * Falls back to cheapest overall if nothing is under limit.
 */
function pickBestProduct(products, searchTerm) {
  if (!products || products.length === 0) return null;

  // Find the applicable price limit (fuzzy match on search term)
  const termLower = searchTerm.toLowerCase();
  let limit = null;
  for (const [key, val] of Object.entries(PRICE_LIMITS)) {
    if (termLower.includes(key.toLowerCase()) || key.toLowerCase().includes(termLower.split(' ')[0])) {
      limit = val * PRICE_BUFFER; // apply buffer
      break;
    }
  }

  // Sort by price ascending (cheapest first), treating null/999 as expensive
  const sorted = [...products].sort((a, b) => (a.price || 999) - (b.price || 999));

  if (limit) {
    // Prefer cheapest product under the limit
    const underLimit = sorted.find(p => p.price && p.price <= limit);
    if (underLimit) return underLimit;

    // Everything over limit — warn and pick cheapest anyway
    const cheapest = sorted[0];
    console.log(`  ⚠ PRICE WARNING: "${searchTerm}" cheapest is $${cheapest.price?.toFixed(2)} (limit ~$${limit.toFixed(2)})`);
    return cheapest;
  }

  // No limit defined — just pick cheapest
  return sorted[0];
}

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

async function clearBrowserCache(browser) {
  if (!CLEAR_CACHE) return;
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
  // Try API first — faster and more reliable than DOM clicking
  const apiCleared = await page.evaluate(async () => {
    try {
      // Get current cart items
      const cartRes = await fetch('https://www.woolworths.com.au/apis/ui/Cart/GetCart', {
        method: 'GET',
        credentials: 'include',
      });
      const cart = await cartRes.json();
      const items = cart?.Cart?.Items || cart?.Items || [];
      if (items.length === 0) return 'empty';

      // Remove each item via API
      for (const item of items) {
        const stockcode = item.Stockcode || item.ProductId;
        if (!stockcode) continue;
        await fetch('https://www.woolworths.com.au/apis/ui/Cart/Update', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Stockcode: stockcode, Quantity: 0 }),
        });
      }
      return 'cleared';
    } catch (e) {
      return 'error:' + e.message;
    }
  });

  if (apiCleared === 'empty') {
    console.log('  Cart already empty.');
    return;
  }
  if (apiCleared === 'cleared') {
    console.log('  Cart cleared via API.');
    return;
  }

  // Fallback: DOM clicking (in case API changes)
  console.log(`  API clear failed (${apiCleared}), falling back to DOM...`);
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
    console.log(`  Clicked: ${ordered}`);
    console.log('  Waiting for order confirmation...');

    // Wait up to 30s for confirmation page or success indicator
    let confirmed = false;
    for (let i = 0; i < 15; i++) {
      await wait(2000);
      const status = await page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();

        // Check for confirmation signals
        if (url.includes('confirmation') || url.includes('order-complete') || url.includes('thankyou')) return 'confirmed';
        if (text.includes('order confirmed') || text.includes('order has been placed') ||
            text.includes('thank you for your order') || text.includes('order number')) return 'confirmed';

        // Check for errors / still waiting
        if (text.includes('cvv') || text.includes('security code') || text.includes('card verification')) return 'waiting_cvv';
        if (text.includes('payment failed') || text.includes('card declined') || text.includes('transaction failed')) return 'payment_failed';
        if (text.includes('place order') || text.includes('confirm order')) return 'still_checkout';

        return 'unknown';
      });

      if (status === 'confirmed') {
        confirmed = true;
        console.log('  ORDER CONFIRMED.');
        break;
      } else if (status === 'waiting_cvv') {
        console.log('  BLOCKED: CVV input required. Enter CVV in Chrome and complete manually.');
        break;
      } else if (status === 'payment_failed') {
        console.log('  FAILED: Payment was declined. Check your card in Chrome.');
        break;
      } else if (status === 'still_checkout') {
        // Still on checkout page — button click may not have worked
        if (i === 7) console.log('  Still on checkout page — may need manual intervention...');
      }
    }

    if (!confirmed) {
      console.log('  Order NOT confirmed. Check Chrome to complete.');
    }

    return { total: cartTotal, ordered: confirmed };
  } else {
    console.log('  Could not find Place Order button. Check Chrome.');
    console.log('  URL:', page.url());
    return { total: cartTotal, ordered: false };
  }
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

async function colesSelectDeliverySlot(page) {
  // Open the time picker panel (must be done while trolley is open)
  await page.evaluate(() => document.querySelector('[data-testid="how-and-when-button"]')?.click());
  await wait(2000);

  // Click "As soon as possible" tab
  await page.evaluate(() => {
    const els = document.querySelectorAll('button, div, label');
    for (const el of els) {
      if (el.textContent.trim() === 'As soon as possible' && el.children.length <= 3) {
        el.click(); return;
      }
    }
  });
  await wait(2000);

  // Click the ETA radio (use coordinates: x-20 from "ETA X min" text, y centre)
  const etaPos = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
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
    await wait(2000);
  } else {
    throw new Error('ETA slot not found');
  }

  // Confirm
  const confirmed = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Confirm');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!confirmed) throw new Error('"Confirm" button not found after slot selection');
  await wait(3000);

  // Continue (trolley summary view)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Continue');
    if (btn) btn.click();
  });
  await wait(3000);
}

async function colesCheckoutAndPay(page) {
  const log = [];
  const step = (msg) => { console.log(`  ${msg}`); log.push(msg); };

  // STEP 1: Go to Coles home, open trolley
  step('Opening trolley...');
  await page.goto('https://www.coles.com.au', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(2000);

  const total = await page.evaluate(() =>
    document.querySelector('[data-testid="header-trolley"]')?.textContent?.match(/\$([\d.]+)/)?.[1] || null
  );
  step(`Trolley total: $${total || '?'}`);

  await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
  await wait(3000);

  // STEP 2: Select delivery slot (open time picker, pick ASAP ETA, confirm, continue)
  step('Selecting ASAP delivery slot...');
  try {
    await colesSelectDeliverySlot(page);
    step('Delivery slot confirmed');
  } catch (err) {
    step(`Slot selection warning: ${err.message}`);
    // Sonnet will intervene if needed
  }

  // STEP 3: Click "Checkout" (red button at bottom of trolley panel)
  step('Clicking Checkout...');
  await page.evaluate(() => document.querySelector('[data-testid="checkout"]')?.click());
  await wait(5000);

  // STEP 4: Dismiss "Missing anything?" upsell
  step('Dismissing upsell...');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Continue to checkout'));
    if (btn) btn.click();
  });
  await wait(8000);

  // STEP 5: Handle expired slot (can happen if checkout took too long)
  const slotExpired = await page.evaluate(() => {
    if (document.body.innerText.includes('no longer available')) {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Pick a new slot'));
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (slotExpired) {
    step('Slot expired — re-selecting...');
    await wait(3000);
    try {
      await colesSelectDeliverySlot(page);
      step('Re-selected delivery slot');
    } catch {}
    await wait(2000);
    await page.evaluate(() => document.querySelector('[data-testid="checkout"]')?.click());
    await wait(5000);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Continue to checkout'));
      if (btn) btn.click();
    });
    await wait(8000);
  }

  // STEP 6: Confirm trolley & substitutions (order review page)
  step('Confirming order review...');
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="complete-review-trolley-&-substitutions"]') ||
      Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent.includes('Confirm') || b.textContent.includes('Review')
      );
    if (btn) btn.click();
  });
  await wait(5000);

  // STEP 7: CVV (if payment processor shows it — Coles Plus often skips this)
  if (CVV) {
    step('Entering CVV if required...');
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
                (ml >= 3 && ml <= 4 && (input.type === 'tel' || input.type === 'password'))) {
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

  // STEP 8: Place Order — try data-testid first (most reliable), then text fallback
  step('Placing order...');
  const ordered = await page.evaluate(() => {
    const byTestId = document.querySelector('[data-testid="place-order-button"]');
    if (byTestId) { byTestId.click(); return byTestId.textContent.trim(); }

    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase().trim();
      if (text.includes('place order') || text.includes('pay now') ||
          text.includes('complete order') || text.includes('submit order')) {
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
    const ssPath = tempPath('coles-final.png');
    await page.screenshot({ path: ssPath });
    step(`FAILED: Could not find Place Order button — screenshot at ${ssPath}`);
  }

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

async function checkoutOnly(store) {
  const browser = await connectChrome();
  try {
    const page = await getPage(browser, store === 'woolworths' ? 'woolworths.com.au' : 'coles.com.au');
    const checkoutFn = store === 'woolworths' ? woolworthsCheckoutAndPay : colesCheckoutAndPay;
    console.log(`\n  ── CHECKOUT ${store.toUpperCase()} ──\n`);
    const result = await checkoutFn(page);
    if (result.ordered) {
      console.log(`\n  ORDER CONFIRMED`);
      console.log(`  Delivery: ASAP`);
      console.log(`  Instructions: ${DELIVERY_INSTRUCTIONS}`);
      console.log(`\n  Groceries are on their way!\n`);
    } else {
      console.log(`\n  ORDER NOT COMPLETED`);
      console.log(`  Open Chrome and complete checkout manually.\n`);
    }
  } finally {
    browser.disconnect();
  }
}

async function buy(store, items, skipCheckout = false) {
  const browser = await connectChrome();
  await clearBrowserCache(browser);

  let priceComparison = null;

  try {
    if (store === 'auto') {
      // Compare and pick cheapest
      console.log(`\n  Comparing prices for ${items.length} items...\n`);

      const wPage = await getPage(browser, 'woolworths.com.au');
      const cPage = await getPage(browser, 'coles.com.au');

      let wTotal = 0, cTotal = 0;
      const rows = [];
      for (const item of items) {
        const wProducts = await woolworthsSearch(wPage, item);
        const cProducts = await colesSearch(cPage, item);
        const wBest = pickBestProduct(wProducts, item);
        const cBest = pickBestProduct(cProducts, item);
        const wPrice = wBest?.price || 999;
        const cPrice = cBest?.price || 999;
        wTotal += wPrice === 999 ? 0 : wPrice;
        cTotal += cPrice === 999 ? 0 : cPrice;
        const best = wPrice <= cPrice ? 'W' : 'C';
        rows.push({ item, wPrice, cPrice, best, wName: wBest?.name, cName: cBest?.name });
        console.log(`  ${item.padEnd(35)} W: $${wPrice === 999 ? '?' : wPrice.toFixed(2).padEnd(8)} C: $${cPrice === 999 ? '?' : cPrice.toFixed(2).padEnd(8)} ${best}`);
      }

      store = wTotal <= cTotal ? 'woolworths' : 'coles';
      const savings = Math.abs(wTotal - cTotal);
      priceComparison = { rows, wTotal, cTotal, chosen: store, savings };

      console.log(`\n  Woolworths: $${wTotal.toFixed(2)} | Coles: $${cTotal.toFixed(2)}`);
      console.log(`  → Ordering from ${store} (saving $${savings.toFixed(2)})\n`);
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

      const best = pickBestProduct(products, item);
      if (!best) { console.log('no suitable product'); continue; }
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

    // 3. Checkout and pay (unless --no-checkout)
    if (skipCheckout) {
      console.log(`\n  ── CART READY ──`);
      console.log(`  Store: ${store.toUpperCase()}`);
      console.log(`  Items: ${added}`);
      console.log(`  Estimated total: $${total.toFixed(2)}`);

      if (priceComparison) {
        console.log(`\n  ── PRICE COMPARISON ──`);
        console.log(`  ${'Item'.padEnd(30)} ${'Woolworths'.padEnd(12)} ${'Coles'.padEnd(12)} Best`);
        console.log(`  ${'─'.repeat(66)}`);
        for (const row of priceComparison.rows) {
          const wStr = row.wPrice === 999 ? 'N/A' : `$${row.wPrice.toFixed(2)}`;
          const cStr = row.cPrice === 999 ? 'N/A' : `$${row.cPrice.toFixed(2)}`;
          const bestLabel = row.best === 'W' ? 'Woolworths' : 'Coles';
          console.log(`  ${row.item.padEnd(30)} ${wStr.padEnd(12)} ${cStr.padEnd(12)} ${bestLabel}`);
        }
        console.log(`  ${'─'.repeat(66)}`);
        console.log(`  ${'TOTAL'.padEnd(30)} $${priceComparison.wTotal.toFixed(2).padEnd(11)} $${priceComparison.cTotal.toFixed(2).padEnd(11)}`);
        console.log(`\n  Decision: ${priceComparison.chosen.toUpperCase()} — saving $${priceComparison.savings.toFixed(2)}`);
      }

      console.log(`\n  Confirm order? Reply "yes" to place the order, "no" to cancel.\n`);

      // Save pending order state
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');
      writeFileSync(
        join(homedir(), '.claude-gombwe', 'data', 'pending-order.json'),
        JSON.stringify({ store, items: added, total, priceComparison, timestamp: new Date().toISOString() }, null, 2)
      );
    } else {
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
      } else {
        console.log(`\n  ORDER NOT COMPLETED`);
        console.log(`  Items are in your ${store} cart (${added} items, ~$${total.toFixed(2)})`);
        console.log(`  Open Chrome and complete checkout manually.`);
        console.log(`  Common reasons: CVV required, payment issue, delivery slot needed.\n`);
      }
    }

  } finally {
    browser.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const noCheckout = args.includes('--no-checkout');
const checkoutOnlyFlag = args.includes('--checkout-only');
const filtered = args.filter(a => !a.startsWith('--'));
const [store, ...items] = filtered;

if (checkoutOnlyFlag && store) {
  checkoutOnly(store).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
} else if (!store || items.length === 0) {
  console.log(`
  grocery-buy — Delivered groceries, zero clicks.

  Usage:
    node grocery-buy.mjs auto "milk 2L" "eggs" "bread"                Add to cart + checkout
    node grocery-buy.mjs auto "milk 2L" "eggs" --no-checkout           Add to cart, wait for confirmation
    node grocery-buy.mjs --checkout-only woolworths                    Checkout existing cart
    node grocery-buy.mjs woolworths "milk 2L" "eggs"                   Buy from Woolworths
    node grocery-buy.mjs coles "milk 2L" "eggs"                        Buy from Coles
  `);
  process.exit(0);
} else if (!['auto', 'woolworths', 'coles'].includes(store)) {
  console.error(`Unknown store: ${store}. Use: auto, woolworths, or coles`);
  process.exit(1);
} else {
  buy(store, items, noCheckout).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
