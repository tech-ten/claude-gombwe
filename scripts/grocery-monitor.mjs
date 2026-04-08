#!/usr/bin/env node

/**
 * GROCERY MONITOR — wraps grocery-buy.mjs with real-time AI monitoring.
 *
 * The mechanical script runs each step. If a step fails, THIS module:
 *   1. Takes a screenshot of what's on screen
 *   2. Calls Claude with: "Step X failed. Here's the error. Here's the screenshot. Fix it."
 *   3. Claude returns a JavaScript snippet to execute in the browser
 *   4. The monitor executes the fix
 *   5. Retries the step
 *
 * Claude doesn't touch the happy path. It only wakes up when something breaks.
 */

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import puppeteer from 'puppeteer-core';

const PORT = 19222;
const PREFS_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-preferences.json');
const LOG_FILE = join(homedir(), '.claude-gombwe', 'data', 'grocery-last-run.json');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let PREFS = {};
try { PREFS = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')); } catch {}
const CVV = PREFS.payment?.cvv || null;
const DELIVERY_INSTRUCTIONS = PREFS.delivery?.instructions || 'Please leave at front door / pouch. Thank you.';

const log = [];
const step = (msg) => { console.log(`  ${msg}`); log.push({ time: new Date().toISOString(), msg }); };

/**
 * Ask Claude to fix a problem. Returns a JS snippet to execute in the browser.
 */
async function askClaudeToFix(problem, pageUrl, screenshotPath) {
  step(`AI INTERVENING: ${problem}`);

  const prompt = `You are monitoring a grocery checkout automation script. A step has failed.

Problem: ${problem}
Current URL: ${pageUrl}
Screenshot: The user is on the Coles or Woolworths checkout flow.

The script uses Puppeteer to control Chrome. I need you to return ONLY a JavaScript snippet
that I can run with page.evaluate() to fix this problem. The snippet should click the right button,
fill the right field, or navigate to the right page.

Rules:
- Return ONLY the JavaScript code, no explanation
- The code runs inside page.evaluate() so use document.querySelector etc.
- Do not wrap in markdown code blocks
- If you need to click a button, find it by text content or data-testid
- If the slot expired, pick a new one
- If a dialog appeared, dismiss it
- If we need to go back and retry, navigate to the right URL`;

  try {
    const result = execSync(
      `claude -p "${prompt.replace(/"/g, '\\"')}" --output-format text --dangerously-skip-permissions --verbose --model claude-sonnet-4-6`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    step(`AI suggested fix (${result.length} chars)`);
    return result.trim();
  } catch (err) {
    step(`AI failed to respond: ${err.message}`);
    return null;
  }
}

/**
 * Execute a step with retry and AI monitoring.
 */
async function executeStep(page, name, fn, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (result === false) throw new Error(`${name} returned false`);
      step(`${name}: OK`);
      return result;
    } catch (err) {
      step(`${name}: FAILED (attempt ${attempt}) — ${err.message}`);

      if (attempt > maxRetries) {
        step(`${name}: All retries exhausted`);
        return false;
      }

      // Take screenshot
      const ssPath = `/tmp/grocery-fail-${Date.now()}.png`;
      try { await page.screenshot({ path: ssPath }); } catch {}

      // Ask Claude to fix
      const fix = await askClaudeToFix(
        `${name} failed: ${err.message}`,
        page.url(),
        ssPath
      );

      if (fix) {
        try {
          step(`Applying AI fix...`);
          await page.evaluate(fix);
          await wait(3000);
        } catch (fixErr) {
          step(`AI fix failed to execute: ${fixErr.message}`);
        }
      }
    }
  }
  return false;
}

/**
 * Connect to Chrome
 */
async function connectChrome() {
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch {}

  const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
  if (!existsSync(PROFILE_DIR)) { console.error('Run: gombwe grocery-setup'); process.exit(1); }

  const chromePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => existsSync(p));
  if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }

  spawn(chromePath, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.coles.com.au', 'https://www.woolworths.com.au',
  ], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 15; i++) {
    await wait(2000);
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch {}
  }
  console.error('Chrome failed.'); process.exit(1);
}

/**
 * COLES — full monitored checkout
 */
async function colesMonitoredCheckout(page, items) {
  step('=== COLES MONITORED CHECKOUT ===');

  // SEARCH AND ADD
  for (const item of items) {
    await executeStep(page, `Search: ${item}`, async () => {
      await page.goto(`https://www.coles.com.au/search/products?q=${encodeURIComponent(item)}`, {
        waitUntil: 'networkidle2', timeout: 20000
      });
      await wait(4000);
      return true;
    });

    await executeStep(page, `Add to cart: ${item}`, async () => {
      const added = await page.evaluate(() => {
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
      if (!added) throw new Error('Add button not found');
      await wait(2000);
      return true;
    });
  }

  // CHECKOUT FLOW
  await executeStep(page, 'Go to Coles home', async () => {
    await page.goto('https://www.coles.com.au', { waitUntil: 'networkidle2', timeout: 15000 });
    await wait(2000);
    return true;
  });

  await executeStep(page, 'Open trolley', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
    await wait(3000);
    const total = await page.evaluate(() =>
      document.querySelector('[data-testid="header-trolley"]')?.textContent?.match(/\$([\d.]+)/)?.[1]
    );
    step(`  Trolley: $${total || '?'}`);
    return true;
  });

  await executeStep(page, 'Open delivery time picker', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="how-and-when-button"]')?.click());
    await wait(2000);
    return true;
  });

  await executeStep(page, 'Select ASAP delivery', async () => {
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

    // Click the ETA radio by coordinates
    const pos = await page.evaluate(() => {
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

    if (pos) {
      await page.mouse.click(pos.x - 20, pos.y + pos.h / 2);
      await wait(2000);
    } else {
      throw new Error('ETA slot not found on page');
    }
    return true;
  });

  await executeStep(page, 'Confirm delivery slot', async () => {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Confirm');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('Confirm button not found');
    await wait(3000);
    return true;
  });

  await executeStep(page, 'Continue past summary', async () => {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Continue');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('Continue button not found');
    await wait(3000);
    return true;
  });

  await executeStep(page, 'Click Checkout', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="checkout"]')?.click());
    await wait(5000);
    return true;
  });

  await executeStep(page, 'Dismiss upsell (Missing anything?)', async () => {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.includes('Continue to checkout'));
      if (btn) btn.click();
    });
    await wait(8000);
    return true;
  });

  // Handle slot expiry (can happen if checkout took too long)
  await executeStep(page, 'Check for expired slot', async () => {
    const expired = await page.evaluate(() => {
      if (document.body.innerText.includes('no longer available')) {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('Pick a new slot'));
        if (btn) { btn.click(); return 'expired'; }
      }
      return 'ok';
    });
    if (expired === 'expired') {
      step('  Slot expired — re-opening trolley and re-selecting...');
      await wait(3000);
      // Re-open trolley and repeat slot selection
      await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
      await wait(2000);
      await page.evaluate(() => document.querySelector('[data-testid="how-and-when-button"]')?.click());
      await wait(2000);
      throw new Error('Slot expired — retry will pick a new slot');
    }
    return true;
  });

  // CVV
  if (CVV) {
    await executeStep(page, 'Enter CVV', async () => {
      // Check all frames (payment processors use iframes)
      const frames = page.frames();
      let entered = false;
      for (const frame of frames) {
        try {
          const found = await frame.evaluate((cvv) => {
            const inputs = document.querySelectorAll('input');
            for (const input of inputs) {
              const label = (input.getAttribute('aria-label') || input.placeholder ||
                             input.name || input.id || '').toLowerCase();
              const ml = input.maxLength;
              if (label.includes('cvv') || label.includes('cvc') || label.includes('security') ||
                  (ml >= 3 && ml <= 4 && (input.type === 'tel' || input.type === 'password' || input.type === 'text'))) {
                input.focus();
                input.value = cvv;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            return false;
          }, CVV);
          if (found) { entered = true; break; }
        } catch {}
      }
      if (!entered) step('  CVV field not found (may not be required yet)');
      await wait(2000);
      return true; // Don't fail on CVV — it might appear later
    });
  }

  // CONFIRM ORDER REVIEW PAGE
  await executeStep(page, 'Confirm order review', async () => {
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="complete-review-trolley-&-substitutions"]') ||
        Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent.includes('Confirm') || b.textContent.includes('Review')
        );
      if (btn) btn.click();
    });
    await wait(5000);
    return true;
  });

  // PLACE ORDER
  const ordered = await executeStep(page, 'Place order', async () => {
    const clicked = await page.evaluate(() => {
      // Try reliable data-testid first (confirmed working)
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
    if (!clicked) throw new Error('Place Order button not found');
    await wait(5000);
    return clicked;
  });

  // Save log
  const report = {
    store: 'coles',
    items: items.length,
    success: !!ordered,
    steps: log,
    timestamp: new Date().toISOString()
  };
  writeFileSync(LOG_FILE, JSON.stringify(report, null, 2));

  if (ordered) {
    step('=== ORDER CONFIRMED ===');
    step(`Delivery: ASAP to ${PREFS.delivery?.address || 'saved address'}`);
    step(`Instructions: ${DELIVERY_INSTRUCTIONS}`);
  } else {
    step('=== ORDER INCOMPLETE — check Chrome ===');
    await page.screenshot({ path: '/tmp/grocery-final-state.png' });
  }

  return report;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

const [store, ...items] = process.argv.slice(2);

if (!store || items.length === 0) {
  console.log('Usage: node grocery-monitor.mjs coles "milk" "eggs" "bread"');
  process.exit(0);
}

const browser = await connectChrome();

try {
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('coles')) || pages[0];

  // Clear cart first
  step('Clearing cart...');
  await page.goto('https://www.coles.com.au', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(2000);
  await page.evaluate(() => document.querySelector('[data-testid="header-trolley"]')?.click());
  await wait(2000);
  // Click remove on each item
  for (let i = 0; i < 30; i++) {
    const removed = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Remove');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!removed) break;
    await wait(1500);
  }
  // Close trolley
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="trolley-close"]') ||
      Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Close'));
    if (btn) btn.click();
  });
  await wait(1000);
  step('Cart cleared');

  await colesMonitoredCheckout(page, items);
} finally {
  browser.disconnect();
}
