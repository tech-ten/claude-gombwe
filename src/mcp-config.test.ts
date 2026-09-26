import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  SESSION_TOKEN_TTL_MS,
  pruneSessionMcpConfigs,
  pruneSessionTokens,
  sessionMcpConfigPath,
  sessionTokenFor,
  writeSessionMcpConfig,
} from './mcp-config.js';
import { Principals } from './permissions.js';
import type { Principal } from './permissions.js';
import type { SessionToken } from './services.js';
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

// ── Session tokens ────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;

test('one token per session, reused across messages', () => {
  const tokens = new Map<string, SessionToken>();
  const first = sessionTokenFor(tokens, 'discord:9', 'liam', 'discord');
  const second = sessionTokenFor(tokens, 'discord:9', 'liam', 'discord');
  assert.equal(first, second);
  assert.equal(tokens.size, 1);
  assert.equal(first.length, 64, '32 random bytes as hex');
  assert.match(first, /^[0-9a-f]{64}$/);

  // A different session is a different credential.
  const other = sessionTokenFor(tokens, 'discord:10', 'liam', 'discord');
  assert.notEqual(other, first);
  assert.equal(tokens.size, 2);
});

test('the person on a session changing drops the old token', () => {
  const tokens = new Map<string, SessionToken>();
  const liams = sessionTokenFor(tokens, 'web:1', 'liam', 'web');
  const mags = sessionTokenFor(tokens, 'web:1', 'mag', 'web');
  assert.notEqual(mags, liams);
  // Liam's token must stop working rather than quietly act as Mag.
  assert.equal(tokens.has(liams), false);
  assert.equal(tokens.get(mags)?.principalId, 'mag');
});

test('a system-originated turn keeps the same token', () => {
  const tokens = new Map<string, SessionToken>();
  const held = sessionTokenFor(tokens, 'discord:9', 'liam', 'discord');
  // This is what an approval decision resuming Liam's conversation looks like:
  // same session, same principal, so the same token comes back.
  const resumed = sessionTokenFor(tokens, 'discord:9', 'liam', 'discord', { keepExisting: true });
  assert.equal(resumed, held);
  assert.equal(tokens.size, 1);
});

test('a system-originated turn never invalidates a live token', () => {
  const tokens = new Map<string, SessionToken>();
  const held = sessionTokenFor(tokens, 'discord:9', 'liam', 'discord');
  // Even if the principal comes back different — Liam taken off the roster
  // mid-conversation — gombwe resuming its own turn must not revoke what the
  // session is already holding.
  sessionTokenFor(tokens, 'discord:9', 'guest:discord:system', 'discord', { keepExisting: true });
  assert.equal(tokens.has(held), true);
  assert.equal(tokens.get(held)?.principalId, 'liam');
});

test('reuse refreshes the stamp, so a long conversation is not pruned', () => {
  const tokens = new Map<string, SessionToken>();
  let t = Date.parse('2026-09-01T09:00:00.000Z');
  const now = () => new Date(t);
  const first = sessionTokenFor(tokens, 'web:1', 'mag', 'web', { now });

  t += 6 * DAY_MS;
  assert.equal(sessionTokenFor(tokens, 'web:1', 'mag', 'web', { now }), first);
  t += 6 * DAY_MS;
  // Twelve days after minting, but only six since it was last handed out.
  assert.equal(sessionTokenFor(tokens, 'web:1', 'mag', 'web', { now }), first);
});

test('minting a token forgets sessions nobody has spoken on', () => {
  const tokens = new Map<string, SessionToken>();
  let t = Date.parse('2026-09-01T09:00:00.000Z');
  const now = () => new Date(t);
  const stale = sessionTokenFor(tokens, 'web:old', 'mag', 'web', { now });
  t += 8 * DAY_MS;
  const fresh = sessionTokenFor(tokens, 'web:new', 'mag', 'web', { now });

  // The sweep runs on the way in, so the map never holds more than the sessions
  // that are actually live.
  assert.deepEqual([...tokens.keys()], [fresh]);
  assert.equal(tokens.has(stale), false);
});

test('pruneSessionTokens drops what is past the TTL and nothing else', () => {
  const tokens = new Map<string, SessionToken>();
  const now = () => new Date(Date.parse('2026-09-20T09:00:00.000Z'));
  const at = (days: number) =>
    new Date(now().getTime() - days * DAY_MS).toISOString();
  tokens.set('stale', { principalId: 'mag', sessionKey: 'web:1', createdAt: at(8) });
  tokens.set('edge', { principalId: 'mag', sessionKey: 'web:2', createdAt: at(6.9) });
  tokens.set('fresh', { principalId: 'mag', sessionKey: 'web:3', createdAt: at(0) });
  tokens.set('unparseable', { principalId: 'mag', sessionKey: 'web:4', createdAt: 'not a date' });

  assert.equal(pruneSessionTokens(tokens, { now }), 1);
  assert.deepEqual([...tokens.keys()].sort(), ['edge', 'fresh', 'unparseable']);
  assert.equal(SESSION_TOKEN_TTL_MS, 7 * DAY_MS);
});

// ── Sweeping old config files ─────────────────────────────────

test('writing a config sweeps files older than the token TTL', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const servers = principals.mcpServersFor(mag);

  const stale = writeSessionMcpConfig(config, dataDir, 'web:gone', mag, 'tok', servers);
  const staleTmp = `${stale}.tmp`;
  writeFileSync(staleTmp, '{}');
  const old = new Date(Date.now() - 8 * DAY_MS);
  utimesSync(stale, old, old);
  utimesSync(staleTmp, old, old);

  const live = writeSessionMcpConfig(config, dataDir, 'web:here', mag, 'tok', servers);

  // Every message writes one of these, so without the sweep the directory grows
  // for the life of the household.
  assert.equal(existsSync(stale), false, 'the eight-day-old config should be gone');
  assert.equal(existsSync(staleTmp), false, 'a leftover temp file should go too');
  assert.equal(existsSync(live), true, 'the file just written is never its own victim');
});

test('the sweep leaves anything inside the TTL alone', () => {
  const { config, dataDir, principals } = build();
  const mag = who(principals, 'mag');
  const servers = principals.mcpServersFor(mag);
  const recent = writeSessionMcpConfig(config, dataDir, 'web:recent', mag, 'tok', servers);
  const sixDays = new Date(Date.now() - 6 * DAY_MS);
  utimesSync(recent, sixDays, sixDays);

  writeSessionMcpConfig(config, dataDir, 'web:other', mag, 'tok', servers);
  assert.equal(existsSync(recent), true);
});

test('pruneSessionMcpConfigs on a directory that does not exist is a no-op', () => {
  const { dataDir } = build();
  assert.equal(pruneSessionMcpConfigs(dataDir), 0);
});
