#!/usr/bin/env node

/**
 * Cross-platform utilities for scripts.
 * Resolves Chrome paths, temp dirs, and process management across macOS, Linux, and Windows.
 */

import { existsSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Find the Chrome/Chromium executable path for the current platform.
 * Returns null if not found.
 */
export function findChrome() {
  const plat = platform();

  const candidates = [];

  if (plat === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    );
  } else if (plat === 'win32') {
    const prefixes = [
      process.env.LOCALAPPDATA,
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean);
    for (const prefix of prefixes) {
      candidates.push(
        join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(prefix, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
    // Also try `which`
    try {
      const path = execSync('which google-chrome 2>/dev/null || which chromium 2>/dev/null || which chromium-browser 2>/dev/null', { encoding: 'utf-8' }).trim();
      if (path) candidates.unshift(path);
    } catch {}
  }

  return candidates.find(p => existsSync(p)) || null;
}

/**
 * Get a cross-platform temp file path.
 */
export function tempPath(filename) {
  return join(tmpdir(), filename);
}

/**
 * Kill processes listening on a given port. Cross-platform.
 */
export function killPort(port) {
  const plat = platform();
  try {
    if (plat === 'win32') {
      // Find PIDs using netstat, then kill them
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' });
      const pids = new Set();
      for (const line of output.trim().split('\n')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
      }
    } else {
      const pids = execSync(`lsof -ti:${port} 2>/dev/null`).toString().trim();
      if (pids) {
        execSync(`kill ${pids} 2>/dev/null`);
      }
    }
  } catch {}
}

/**
 * Returns spawn options suitable for detached Chrome on the current platform.
 */
export function detachedSpawnOptions() {
  const plat = platform();
  if (plat === 'win32') {
    return { detached: true, stdio: 'ignore', windowsHide: true };
  }
  return { detached: true, stdio: 'ignore' };
}
