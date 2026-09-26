import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

test('configDir/dataDir honour GOMBWE_CONFIG_DIR when set', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gombwe-paths-'));
  process.env.GOMBWE_CONFIG_DIR = d;
  try {
    const { configDir, dataDir } = await import('./paths.js');
    assert.equal(configDir(), d);
    assert.equal(dataDir(), join(d, 'data'));
    assert.ok(configDir().startsWith(d));
    assert.ok(dataDir().startsWith(d));
  } finally {
    delete process.env.GOMBWE_CONFIG_DIR;
  }
});

test('configDir/dataDir fall back to the home directory when unset', async () => {
  delete process.env.GOMBWE_CONFIG_DIR;
  const { configDir, dataDir } = await import('./paths.js');
  assert.equal(configDir(), join(homedir(), '.claude-gombwe'));
  assert.equal(dataDir(), join(homedir(), '.claude-gombwe', 'data'));
});

test('configDir() re-reads the env var on every call (computed at call time)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gombwe-paths-'));
  const { configDir } = await import('./paths.js');
  const before = configDir();
  process.env.GOMBWE_CONFIG_DIR = d;
  try {
    assert.notEqual(configDir(), before);
    assert.equal(configDir(), d);
  } finally {
    delete process.env.GOMBWE_CONFIG_DIR;
  }
});
