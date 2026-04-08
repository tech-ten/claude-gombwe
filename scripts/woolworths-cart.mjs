#!/usr/bin/env node

import puppeteer from 'puppeteer-core';

const CHROME_DEBUG_URL = 'http://127.0.0.1:19222';
const items = process.argv.slice(2);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

if (items.length === 0) {
  console.log('Usage: node scripts/woolworths-cart.mjs "item1" "item2" "item3"');
  process.exit(1);
}

async function main() {
  const browser = await puppeteer.connect({
    browserURL: CHROME_DEBUG_URL,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('woolworths.com.au'));

  if (!page) {
    page = await browser.newPage();
    await page.goto('https://www.woolworths.com.au');
    await wait(3000);
  }

  console.log(`\nConnected to Woolworths. Adding ${items.length} items.\n`);

  for (const item of items) {
    console.log(`Searching: ${item}...`);

    await page.goto(
      `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item)}`,
      { waitUntil: 'networkidle2', timeout: 15000 }
    );
    await wait(3000);

    try {
      // Find all buttons, look for "Add to cart"
      const added = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('add to cart') || text === 'add') {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (added) {
        await wait(1500);
        console.log(`  + Added: ${item}`);
      } else {
        console.log(`  - Could not find Add button for: ${item}`);
      }
    } catch (err) {
      console.log(`  ! Error: ${err.message}`);
    }
  }

  console.log('\nChecking cart...');
  await page.goto('https://www.woolworths.com.au/shop/cart', {
    waitUntil: 'networkidle2',
    timeout: 15000,
  });
  await wait(3000);

  const total = await page.evaluate(() => {
    const el = document.querySelector('[class*="cart-total"], [class*="cartTotal"], [data-testid*="total"]');
    return el ? el.textContent.trim() : null;
  });

  if (total) console.log(`Cart total: ${total}`);
  else console.log('Check your Chrome window to see the cart.');

  browser.disconnect();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
