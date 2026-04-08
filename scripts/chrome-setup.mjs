#!/usr/bin/env node

/**
 * One-time Chrome setup for grocery automation.
 * Launches Chrome with remote debugging, opens Woolworths and Coles login pages,
 * waits for the user to log in, then saves the session for future use.
 *
 * Usage: node scripts/chrome-setup.mjs
 * After this, grocery.mjs can use the saved session.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findChrome, killPort, detachedSpawnOptions } from './platform.mjs';

const PROFILE_DIR = join(homedir(), '.claude-gombwe', 'chrome-profile');
const PORT = 19222;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   Grocery Setup                         │
  │   One-time login for Woolworths & Coles │
  │                                         │
  └─────────────────────────────────────────┘
  `);

  // Create persistent profile directory
  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    console.log('  Created browser profile at ~/.claude-gombwe/chrome-profile');
  } else {
    console.log('  Using existing browser profile');
  }

  // Kill any existing Chrome on our debug port
  killPort(PORT);
  await wait(2000);

  // Find Chrome
  const chromePath = findChrome();

  if (!chromePath) {
    console.log('  Chrome not found. Please install Google Chrome.');
    process.exit(1);
  }

  console.log('  Launching Chrome...\n');

  // Launch Chrome with persistent profile and remote debugging
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.woolworths.com.au/shop/securelogin',
    'https://www.coles.com.au/login',
  ], detachedSpawnOptions());
  chrome.unref();

  await wait(5000);

  console.log('  Two tabs have opened:');
  console.log('    1. Woolworths login');
  console.log('    2. Coles login');
  console.log('');
  console.log('  Log in to both stores. Your session will be saved');
  console.log('  in ~/.claude-gombwe/chrome-profile so you won\'t');
  console.log('  need to log in again.');
  console.log('');
  console.log('  When you\'re done, come back here and press Enter.');
  console.log('');

  // Wait for user to press Enter
  await new Promise((resolve) => {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  // Verify logins
  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch {
    console.log('  Installing puppeteer-core...');
    execSync('npm install -g puppeteer-core', { stdio: 'ignore' });
    puppeteer = await import('puppeteer-core');
  }

  try {
    const browser = await puppeteer.default.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
      defaultViewport: null,
    });

    const pages = await browser.pages();

    // Check Woolworths
    const wPage = pages.find(p => p.url().includes('woolworths'));
    let wLoggedIn = false;
    if (wPage) {
      const wText = await wPage.evaluate(() => document.body.innerText.slice(0, 500));
      wLoggedIn = wText.includes('My Account') || wText.includes('Hi,');
    }

    // Check Coles
    const cPage = pages.find(p => p.url().includes('coles'));
    let cLoggedIn = false;
    if (cPage) {
      const cText = await cPage.evaluate(() => document.body.innerText.slice(0, 500));
      cLoggedIn = cText.includes('My Account') || cText.includes('Hi ');
    }

    console.log(`  Woolworths: ${wLoggedIn ? 'logged in' : 'not logged in'}`);
    console.log(`  Coles:      ${cLoggedIn ? 'logged in' : 'not logged in'}`);

    if (wLoggedIn || cLoggedIn) {
      console.log('\n  Setup complete! Your login is saved.');
      console.log('  Next time, just run: gombwe grocery');
      console.log('  Or from Discord: /grocery-order milk, eggs, bread\n');
    } else {
      console.log('\n  Logins not detected. Try logging in again');
      console.log('  and run this setup again.\n');
    }

    browser.disconnect();
  } catch (err) {
    console.log(`  Could not verify logins: ${err.message}`);
    console.log('  The profile is saved — try running a grocery order anyway.\n');
  }
}

main().catch(console.error);
