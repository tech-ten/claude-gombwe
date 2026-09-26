import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { sessionMcpConfigPath, writeSessionMcpConfig } from './mcp-config.js';
import { Principals } from './permissions.js';
import type { Principal } from './permissions.js';
import type { GombweConfig } from './types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-mcpcfg-'));

function build() {
  const dataDir = dir();
  const config = {
    port: 18790,
    host: '0.0.0.0',
    dataDir,
    skillsDirs: [],
    agents: { maxConcurrent: 3, workingDir: dataDir },
    channels: {},
    identity: { name: 'gombwe' },
  } as unknown as GombweConfig;
  const principals = new Principals(dataDir);
  principals.upsert({ id: 'mag', name: 'Mag', role: 'adult', bindings: [], grants: { family: 'read' } });
  principals.upsert({ id: 'liam', name: 'Liam', role: 'child', bindings: [], grants: { memory: 'read' } });
  return { config, dataDir, principals };
}

const who = (principals: Principals, id: string): Principal => {
  const p = principals.get(id);
  assert.ok(p, `missing principal ${id}`);
  return p;
};

type Written = {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
};

const read = (path: string): Written => JSON.parse(readFileSync(path, 'utf-8')) as Written;

test('the path is deterministic per session and lives under data/mcp', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const servers = principals.mcpServersFor(mag);

  const first = writeSessionMcpConfig(config, dataDir, 'discord:123', mag, 'tok-a', servers);
  const second = writeSessionMcpConfig(config, dataDir, 'discord:123', mag, 'tok-b', servers);
  assert.equal(first, second);

  const expected = createHash('sha1').update('discord:123').digest('hex');
  assert.equal(basename(first), `${expected}.json`);
  assert.equal(dirname(first), join(dataDir, 'mcp'));

  // A different session gets a different file.
  const other = writeSessionMcpConfig(config, dataDir, 'discord:456', mag, 'tok-a', servers);
  assert.notEqual(first, other);
});

test('rewriting the same session replaces the token rather than appending', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const servers = principals.mcpServersFor(mag);
  const path = writeSessionMcpConfig(config, dataDir, 'web:1', mag, 'tok-a', servers);
  assert.equal(read(path).mcpServers.gombwe.env?.GOMBWE_SESSION_TOKEN, 'tok-a');
  writeSessionMcpConfig(config, dataDir, 'web:1', mag, 'tok-b', servers);
  assert.equal(read(path).mcpServers.gombwe.env?.GOMBWE_SESSION_TOKEN, 'tok-b');
});

test('the gombwe server carries the four environment variables', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const path = writeSessionMcpConfig(config, dataDir, 'web:1', mag, 'secret-token', principals.mcpServersFor(mag));
  const written = read(path);

  const server = written.mcpServers.gombwe;
  assert.ok(server, 'the gombwe server must always be present');
  assert.equal(server.command, 'node');
  assert.equal(server.args.length, 1);
  assert.match(server.args[0], /mcp[/\\]gombwe\.js$/);
  assert.deepEqual(server.env, {
    GOMBWE_PORT: '18790',
    GOMBWE_SESSION_TOKEN: 'secret-token',
    GOMBWE_PRINCIPAL: 'mag',
    GOMBWE_SESSION_KEY: 'web:1',
  });
});

test('the family server is included for a principal who may read family', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const written = read(writeSessionMcpConfig(config, dataDir, 'web:1', mag, 'tok', principals.mcpServersFor(mag)));
  const family = written.mcpServers['gombwe-family'];
  assert.ok(family, 'mag has family:read, so the family server should be there');
  assert.match(family.args[0], /mcp[/\\]family\.js$/);
  assert.equal(family.env?.GOMBWE_DATA_DIR, dataDir);
  assert.equal(family.env?.GOMBWE_PORT, '18790');
});

test('the family server is omitted for a principal without a family grant', () => {
  const { config, dataDir, principals } = build();
  const liam = who(principals, 'liam');
  const written = read(writeSessionMcpConfig(config, dataDir, 'web:2', liam, 'tok', principals.mcpServersFor(liam)));
  assert.deepEqual(Object.keys(written.mcpServers), ['gombwe']);
});

test('a servers list that names family cannot smuggle it past the grant check', () => {
  const { config, dataDir, principals } = build();
  const liam = who(principals, 'liam');
  const written = read(writeSessionMcpConfig(config, dataDir, 'web:3', liam, 'tok', ['gombwe', 'gombwe-family']));
  assert.deepEqual(Object.keys(written.mcpServers), ['gombwe']);
});

test('third-party server names in the list are ignored', () => {
  const { config, dataDir, principals } = build();
  const owner = who(principals, 'owner');
  const written = read(writeSessionMcpConfig(config, dataDir, 'web:4', owner, 'tok', ['gombwe', 'gombwe-family', 'puppeteer']));
  assert.deepEqual(Object.keys(written.mcpServers).sort(), ['gombwe', 'gombwe-family']);
});

test('the file holds a bearer token, so only this user may read it', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const path = writeSessionMcpConfig(config, dataDir, 'web:1', mag, 'tok', principals.mcpServersFor(mag));
  assert.equal(statSync(path).mode & 0o077, 0, 'group and other must have no access');
  assert.equal(statSync(dirname(path)).mode & 0o077, 0, 'the directory must be this user\'s alone');
});

test('sessionMcpConfigPath answers without writing anything', () => {
  const { dataDir } = build();
  const path = sessionMcpConfigPath(dataDir, 'discord:123');
  assert.equal(basename(path), `${createHash('sha1').update('discord:123').digest('hex')}.json`);
  assert.throws(() => statSync(path));
});
