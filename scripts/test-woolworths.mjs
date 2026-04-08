#!/usr/bin/env node

/**
 * Test script for Woolworths grocery automation.
 * Tests cart clearing, product selection, CVV entry, and checkout button — WITHOUT placing an order.
 *
 * Usage: node scripts/test-woolworths.mjs
 */

import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { findChrome, detachedSpawnOptions } from './platform.mjs';

const PORT = 19222;
const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
const PREFS_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-preferences.json');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let PREFS = {};
try { PREFS = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')); } catch {}
const CVV = PREFS.payment?.cvv || null;

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg, detail) { fail++; console.log(`  ✗ ${msg}`); if (detail) console.log(`    → ${detail}`); }

async function connectChrome() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {}

  if (!existsSync(PROFILE_DIR)) { console.error('Run: gombwe grocery-setup'); process.exit(1); }
  const chromePath = findChrome();
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }

  spawn(chromePath, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.woolworths.com.au',
  ], detachedSpawnOptions()).unref();

  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch {}
  }
  console.error('Chrome failed to start.'); process.exit(1);
}

async function main() {
  console.log('\n  ══ WOOLWORTHS AUTOMATION TEST ══\n');

  const browser = await connectChrome();
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('woolworths'));
  if (!page) {
    page = await browser.newPage();
    await page.goto('https://www.woolworths.com.au', { waitUntil: 'networkidle2', timeout: 20000 });
  }

  // ── TEST 1: Login check ──
  console.log('  ── 1. Login Check ──');
  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText.slice(0, 1000);
    return text.includes('Hi,') || text.includes('My Account') || text.includes('Sign Out');
  });
  if (loggedIn) ok('Logged in to Woolworths');
  else bad('Not logged in — run gombwe grocery-setup');

  // ── TEST 2: Cart API ──
  console.log('\n  ── 2. Cart API ──');

  // First add a test item via search API
  const searchResult = await page.evaluate(async () => {
    try {
      const res = await fetch('https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=milk+2L&pageSize=3', {
        headers: { 'Accept': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      const products = [];
      for (const g of (data.Products || [])) {
        for (const p of (g.Products || [g])) {
          if (p.Stockcode) products.push({ name: p.DisplayName || p.Name, stockcode: p.Stockcode, price: p.Price });
        }
      }
      return { ok: true, products };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  if (searchResult.ok && searchResult.products.length > 0) {
    ok(`Search API works — found ${searchResult.products.length} results for "milk 2L"`);
    for (const p of searchResult.products.slice(0, 3)) {
      console.log(`    ${p.name} — $${p.price} (stockcode: ${p.stockcode})`);
    }
  } else {
    bad('Search API failed', searchResult.error);
  }

  // Add the first item to cart via API to test cart operations
  if (searchResult.ok && searchResult.products.length > 0) {
    const testItem = searchResult.products[0];
    console.log(`\n  Adding test item: ${testItem.name} (${testItem.stockcode})`);

    const addResult = await page.evaluate(async (stockcode) => {
      try {
        const res = await fetch('https://www.woolworths.com.au/apis/ui/Cart/Update', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Stockcode: stockcode, Quantity: 1 }),
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      } catch (e) { return { ok: false, error: e.message }; }
    }, testItem.stockcode);

    if (addResult.ok) ok('Cart Add API works');
    else bad('Cart Add API failed', JSON.stringify(addResult));

    // Now check cart contents
    const cartResult = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.woolworths.com.au/apis/ui/Cart/GetCart', {
          method: 'GET',
          credentials: 'include',
        });
        const data = await res.json();

        // Try multiple response shapes
        let items = [];
        if (data.Cart?.Items) items = data.Cart.Items;
        else if (data.Items) items = data.Items;
        else if (data.AvailableItems) items = data.AvailableItems;
        else if (Array.isArray(data)) items = data;

        return {
          ok: res.ok,
          status: res.status,
          itemCount: items.length,
          items: items.map(i => ({
            name: i.DisplayName || i.Name || i.Description || 'unknown',
            stockcode: i.Stockcode || i.ProductId || 'unknown',
            quantity: i.Quantity || i.QuantityInTrolley || 1,
          })),
          rawKeys: Object.keys(data).slice(0, 10),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    });

    if (cartResult.ok) {
      ok(`Cart GetCart API works — ${cartResult.itemCount} items`);
      console.log(`    Response keys: ${cartResult.rawKeys.join(', ')}`);
      for (const i of cartResult.items.slice(0, 5)) {
        console.log(`    ${i.name} (qty: ${i.quantity}, code: ${i.stockcode})`);
      }
    } else {
      bad('Cart GetCart API failed', JSON.stringify(cartResult));
    }

    // ── TEST 3: Clear cart ──
    console.log('\n  ── 3. Cart Clear ──');

    if (cartResult.ok && cartResult.itemCount > 0) {
      const clearResult = await page.evaluate(async (items) => {
        const results = [];
        for (const item of items) {
          try {
            const res = await fetch('https://www.woolworths.com.au/apis/ui/Cart/Update', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ Stockcode: parseInt(item.stockcode) || item.stockcode, Quantity: 0 }),
            });
            results.push({ stockcode: item.stockcode, ok: res.ok, status: res.status });
          } catch (e) {
            results.push({ stockcode: item.stockcode, ok: false, error: e.message });
          }
        }
        return results;
      }, cartResult.items);

      const allOk = clearResult.every(r => r.ok);
      if (allOk) ok(`Cleared ${clearResult.length} items via API`);
      else {
        bad('Some items failed to clear');
        for (const r of clearResult) console.log(`    ${r.stockcode}: ${r.ok ? 'OK' : r.status + ' ' + (r.error || '')}`);
      }

      // Verify cart is empty
      const verifyResult = await page.evaluate(async () => {
        const res = await fetch('https://www.woolworths.com.au/apis/ui/Cart/GetCart', {
          method: 'GET', credentials: 'include',
        });
        const data = await res.json();
        let items = data.Cart?.Items || data.Items || data.AvailableItems || [];
        return items.length;
      });

      if (verifyResult === 0) ok('Cart verified empty');
      else bad(`Cart still has ${verifyResult} items after clear`);
    } else {
      bad('Cannot test clear — cart was empty or GetCart failed');
    }
  }

  // ── TEST 4: Product selection (organic vs regular) ──
  console.log('\n  ── 4. Product Selection (organic vs regular) ──');

  const testSearches = ['milk 2L', 'eggs 12 pack', 'chicken breast'];
  for (const query of testSearches) {
    const results = await page.evaluate(async (q) => {
      const res = await fetch(`https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageSize=5`, {
        headers: { 'Accept': 'application/json' }, credentials: 'include',
      });
      const data = await res.json();
      const products = [];
      for (const g of (data.Products || [])) {
        for (const p of (g.Products || [g])) {
          if (p.Stockcode) {
            products.push({
              name: p.DisplayName || p.Name,
              price: p.Price || p.InstorePrice,
              isOrganic: (p.DisplayName || p.Name || '').toLowerCase().includes('organic'),
              isFreeRange: (p.DisplayName || p.Name || '').toLowerCase().includes('free range'),
              stockcode: p.Stockcode,
            });
          }
        }
      }
      return products;
    }, query);

    console.log(`\n  "${query}" → ${results.length} results:`);
    for (const p of results.slice(0, 5)) {
      const tags = [p.isOrganic ? 'ORGANIC' : '', p.isFreeRange ? 'FREE-RANGE' : ''].filter(Boolean).join(' ');
      console.log(`    ${p.price ? '$' + p.price.toFixed(2) : '$?'} ${p.name} ${tags ? '(' + tags + ')' : ''}`);
    }

    // Check if first result is organic when query didn't ask for it
    if (results.length > 0 && results[0].isOrganic && !query.toLowerCase().includes('organic')) {
      bad(`First result for "${query}" is organic — should prefer regular`);
    } else if (results.length > 0) {
      ok(`First result for "${query}" is not unnecessarily organic`);
    }
  }

  // ── TEST 5: Checkout page & CVV ──
  console.log('\n  ── 5. Checkout Page Analysis ──');

  // Add a cheap item first so we can view checkout
  if (searchResult.ok && searchResult.products.length > 0) {
    await page.evaluate(async (stockcode) => {
      await fetch('https://www.woolworths.com.au/apis/ui/Cart/Update', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Stockcode: stockcode, Quantity: 1 }),
      });
    }, searchResult.products[0].stockcode);
    await wait(2000);
  }

  // Navigate to checkout
  await page.goto('https://www.woolworths.com.au/shop/checkout', { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(5000);

  const checkoutAnalysis = await page.evaluate(() => {
    const analysis = {
      url: window.location.href,
      onCheckout: window.location.href.includes('checkout'),
      bodyText: document.body.innerText.slice(0, 3000),
    };

    // Find all inputs and their attributes
    analysis.inputs = [];
    document.querySelectorAll('input, textarea').forEach(input => {
      analysis.inputs.push({
        type: input.type || 'text',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.getAttribute('placeholder') || '',
        ariaLabel: input.getAttribute('aria-label') || '',
        maxLength: input.maxLength,
        visible: input.offsetParent !== null,
      });
    });

    // Find all iframes (payment often in iframe)
    analysis.iframes = [];
    document.querySelectorAll('iframe').forEach(iframe => {
      analysis.iframes.push({
        src: iframe.src || '',
        name: iframe.name || '',
        id: iframe.id || '',
        title: iframe.title || '',
      });
    });

    // Find shadow DOM elements
    analysis.shadowHosts = 0;
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) analysis.shadowHosts++;
    });

    // Find buttons on checkout
    analysis.buttons = [];
    document.querySelectorAll('button').forEach(btn => {
      const text = (btn.textContent || '').trim();
      if (text.length > 0 && text.length < 50) {
        analysis.buttons.push({
          text,
          disabled: btn.disabled,
          ariaLabel: btn.getAttribute('aria-label') || '',
          classes: btn.className.slice(0, 100),
        });
      }
    });

    return analysis;
  });

  console.log(`  URL: ${checkoutAnalysis.url}`);
  console.log(`  On checkout: ${checkoutAnalysis.onCheckout}`);
  console.log(`  Shadow DOM hosts: ${checkoutAnalysis.shadowHosts}`);

  console.log(`\n  Inputs found (${checkoutAnalysis.inputs.length}):`);
  for (const inp of checkoutAnalysis.inputs.filter(i => i.visible)) {
    console.log(`    [${inp.type}] name="${inp.name}" placeholder="${inp.placeholder}" aria="${inp.ariaLabel}" maxLen=${inp.maxLength}`);
  }

  console.log(`\n  Iframes found (${checkoutAnalysis.iframes.length}):`);
  for (const iframe of checkoutAnalysis.iframes) {
    console.log(`    src="${iframe.src.slice(0, 80)}" name="${iframe.name}" title="${iframe.title}"`);
  }

  // Check if CVV is in an iframe (common for payment)
  const hasCvvInput = checkoutAnalysis.inputs.some(i =>
    i.placeholder.toLowerCase().includes('cvv') ||
    i.ariaLabel.toLowerCase().includes('cvv') ||
    i.name.toLowerCase().includes('cvv') ||
    i.ariaLabel.toLowerCase().includes('security code')
  );

  const hasPaymentIframe = checkoutAnalysis.iframes.some(i =>
    i.src.includes('payment') || i.src.includes('checkout') ||
    i.src.includes('card') || i.src.includes('braintree') ||
    i.src.includes('stripe') || i.src.includes('adyen') ||
    i.title.toLowerCase().includes('payment') || i.title.toLowerCase().includes('card')
  );

  if (hasCvvInput) ok('CVV input found in main page');
  else if (hasPaymentIframe) {
    bad('CVV is likely inside a payment iframe — cannot access with page.evaluate()');
    console.log('    Payment iframes detected. CVV input requires switching to iframe context.');

    // Try to access iframe content
    for (const iframe of checkoutAnalysis.iframes) {
      if (iframe.src.includes('payment') || iframe.src.includes('card') ||
          iframe.title.toLowerCase().includes('payment') || iframe.title.toLowerCase().includes('card')) {
        console.log(`    → Trying iframe: ${iframe.src.slice(0, 80)}`);
      }
    }
  } else {
    bad('No CVV input found anywhere — may need shadow DOM traversal or iframe access');
  }

  // Check for shadow DOM CVV
  const shadowCvv = await page.evaluate(() => {
    function findInShadow(root, depth = 0) {
      if (depth > 5) return null;
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (el.shadowRoot) {
          const inputs = el.shadowRoot.querySelectorAll('input');
          for (const input of inputs) {
            const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') ||
                           input.getAttribute('name') || '').toLowerCase();
            if (label.includes('cvv') || label.includes('cvc') || label.includes('security code')) {
              return { found: 'shadow', label, type: input.type, depth };
            }
          }
          const nested = findInShadow(el.shadowRoot, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    }
    return findInShadow(document);
  });

  if (shadowCvv) {
    ok(`CVV input found in shadow DOM at depth ${shadowCvv.depth}: "${shadowCvv.label}"`);
  }

  // Try to find CVV in iframes
  const frames = page.frames();
  console.log(`\n  Page frames (${frames.length}):`);
  for (const frame of frames) {
    const url = frame.url();
    if (url && url !== 'about:blank') console.log(`    ${url.slice(0, 100)}`);

    try {
      const iframeCvv = await frame.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        const found = [];
        for (const input of inputs) {
          const label = (input.getAttribute('aria-label') || input.getAttribute('placeholder') ||
                         input.getAttribute('name') || input.id || '').toLowerCase();
          const type = input.type || '';
          if (label.includes('cvv') || label.includes('cvc') || label.includes('security') ||
              label.includes('verification') || (type === 'tel' && input.maxLength >= 3 && input.maxLength <= 4)) {
            found.push({ label, type, maxLength: input.maxLength, id: input.id, name: input.name });
          }
        }
        return found;
      });

      if (iframeCvv.length > 0) {
        ok(`CVV input found in iframe: ${url.slice(0, 60)}`);
        for (const f of iframeCvv) console.log(`    type="${f.type}" name="${f.name}" id="${f.id}" label="${f.label}" maxLen=${f.maxLength}`);
      }
    } catch {}
  }

  console.log(`\n  Buttons on checkout (${checkoutAnalysis.buttons.length}):`);
  for (const btn of checkoutAnalysis.buttons) {
    const flag = btn.text.toLowerCase().includes('place order') || btn.text.toLowerCase().includes('checkout') ? ' ← TARGET' : '';
    console.log(`    "${btn.text}" disabled=${btn.disabled}${flag}`);
  }

  // Clean up — remove test item from cart
  if (searchResult.ok && searchResult.products.length > 0) {
    await page.evaluate(async (stockcode) => {
      await fetch('https://www.woolworths.com.au/apis/ui/Cart/Update', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Stockcode: stockcode, Quantity: 0 }),
      });
    }, searchResult.products[0].stockcode);
  }

  // ── Summary ──
  console.log(`\n  ══ RESULTS: ${pass} passed, ${fail} failed ══\n`);

  browser.disconnect();
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
