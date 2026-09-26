import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('GOMBWE_CONFIG_DIR redirects the config dir away from the home directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gombwe-config-'));
  process.env.GOMBWE_CONFIG_DIR = d;
  const { loadConfig, getConfigDir } = await import('./config.js?' + Date.now());

  const config = loadConfig();
  assert.equal(getConfigDir(), d);
  assert.equal(config.dataDir, join(d, 'data'));
  assert.ok(config.dataDir.startsWith(d), `${config.dataDir} should live under ${d}`);
  assert.ok(existsSync(join(d, 'gombwe.json')), 'gombwe.json should be written into the override dir');
  assert.equal(JSON.parse(readFileSync(join(d, 'gombwe.json'), 'utf-8')).dataDir, join(d, 'data'));
  delete process.env.GOMBWE_CONFIG_DIR;
});
