import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

test('GOMBWE_CONFIG_DIR redirects the config dir away from the home directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gombwe-config-'));
  process.env.GOMBWE_CONFIG_DIR = d;
  try {
    const { loadConfig, getConfigDir } = await import('./config.js?' + Date.now());

    // Checked before loadConfig(), which creates directories and writes a file:
    // if the override did not take, the test must not touch the real home.
    assert.equal(getConfigDir(), d);
    assert.notEqual(getConfigDir(), join(homedir(), '.claude-gombwe'));

    const config = loadConfig();
    assert.equal(config.dataDir, join(d, 'data'));
    assert.ok(config.dataDir.startsWith(d), `${config.dataDir} should live under ${d}`);
    assert.ok(existsSync(join(d, 'gombwe.json')), 'gombwe.json should be written into the override dir');
    assert.equal(JSON.parse(readFileSync(join(d, 'gombwe.json'), 'utf-8')).dataDir, join(d, 'data'));
  } finally {
    delete process.env.GOMBWE_CONFIG_DIR;
  }
});
