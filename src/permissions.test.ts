import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTORS, Principals, identityFromHeaders } from './permissions.js';
import type { Principal } from './permissions.js';
import type { GombweConfig } from './types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-principals-'));

function config(over: Partial<GombweConfig> = {}): GombweConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: over.dataDir ?? dir(),
    skillsDirs: [],
    agents: { maxConcurrent: 1, workingDir: '/tmp' },
    channels: {},
    identity: { name: 'Gombwe' },
    ...over,
  };
}

const person = (over: Partial<Principal> = {}): Principal => ({
  id: 'liam', name: 'Liam', role: 'child', bindings: [], grants: {}, ...over,
});

test('seeds an owner on first run and writes principals.json', () => {
  const d = dir();
  const p = new Principals(d, { ownerName: 'Gombwe' });
  const all = p.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'owner');
  assert.equal(all[0].role, 'owner');
  assert.match(all[0].name, /Gombwe/);
  // The local/LAN dashboard has no Cloudflare Access header, so 'local' is the
  // owner rather than a guest.
  assert.deepEqual(all[0].bindings, [{ channel: 'web', identity: 'local' }]);
  const onDisk = JSON.parse(readFileSync(join(d, 'principals.json'), 'utf-8'));
  assert.equal(onDisk.principals[0].id, 'owner');
});

test('a web request with no Access header resolves to the seeded owner', () => {
  const p = new Principals(dir());
  assert.equal(p.resolve('web', 'local').id, 'owner');
  assert.equal(p.resolve('web', 'local').role, 'owner');
});

test('bind then resolve returns the bound principal', () => {
  const p = new Principals(dir());
  p.upsert(person({ id: 'mag', name: 'Mag', role: 'adult' }));
  p.bind('mag', { channel: 'telegram', identity: '12345' });
  assert.equal(p.resolve('telegram', '12345').id, 'mag');
});

test('an unbound identity resolves to a guest with no grants', () => {
  const p = new Principals(dir());
  const guest = p.resolve('discord', '99887766');
  assert.equal(guest.id, 'guest:discord:99887766');
  assert.equal(guest.role, 'guest');
  assert.deepEqual(guest.grants, {});
  // Guests are not persisted.
  assert.equal(p.get('guest:discord:99887766'), undefined);
  assert.equal(p.list().length, 1);
});

test('can: owner is allowed everything regardless of grants', () => {
  const p = new Principals(dir());
  const owner = p.get('owner')!;
  for (const c of CONNECTORS) {
    assert.equal(p.can(owner, c, 'read'), true, `owner read ${c}`);
    assert.equal(p.can(owner, c, 'act'), true, `owner act ${c}`);
  }
});

test('can: act implies read', () => {
  const p = new Principals(dir());
  const mag = p.upsert(person({ id: 'mag', role: 'adult', grants: { family: 'act' } }));
  assert.equal(p.can(mag, 'family', 'read'), true);
  assert.equal(p.can(mag, 'family', 'act'), true);
});

test('can: read does not imply act', () => {
  const p = new Principals(dir());
  const liam = p.upsert(person({ grants: { family: 'read' } }));
  assert.equal(p.can(liam, 'family', 'read'), true);
  assert.equal(p.can(liam, 'family', 'act'), false);
});

test('can: an ungranted connector is denied at both levels', () => {
  const p = new Principals(dir());
  const liam = p.upsert(person({ grants: { family: 'act' } }));
  assert.equal(p.can(liam, 'network', 'read'), false);
  assert.equal(p.can(liam, 'network', 'act'), false);
});

test('can: a guest is denied everything', () => {
  const p = new Principals(dir());
  const guest = p.resolve('discord', 'stranger');
  assert.equal(p.can(guest, 'family', 'read'), false);
  assert.equal(p.can(guest, 'network', 'read'), false);
});

test('mcpServersFor always includes gombwe and gates gombwe-family on a family grant', () => {
  const p = new Principals(dir());
  const liam = p.upsert(person());
  assert.deepEqual(p.mcpServersFor(liam), ['gombwe']);
  const withFamily = p.upsert(person({ grants: { family: 'read' } }));
  assert.deepEqual(p.mcpServersFor(withFamily), ['gombwe', 'gombwe-family']);
});

test('mcpServersFor exposes third-party servers to the owner only', () => {
  const p = new Principals(dir(), { thirdPartyServers: ['playwright', 'aws'] });
  const owner = p.get('owner')!;
  assert.deepEqual(p.mcpServersFor(owner), ['gombwe', 'gombwe-family', 'playwright', 'aws']);
  const mag = p.upsert(person({ id: 'mag', role: 'adult', grants: { family: 'act' } }));
  assert.deepEqual(p.mcpServersFor(mag), ['gombwe', 'gombwe-family']);
});

test('binding the same identity twice moves it instead of duplicating', () => {
  const p = new Principals(dir());
  p.upsert(person({ id: 'mag', name: 'Mag', role: 'adult' }));
  p.upsert(person({ id: 'liam' }));
  p.bind('mag', { channel: 'telegram', identity: '777' });
  p.bind('liam', { channel: 'telegram', identity: '777' });
  assert.deepEqual(p.get('mag')!.bindings, []);
  assert.deepEqual(p.get('liam')!.bindings, [{ channel: 'telegram', identity: '777' }]);
  assert.equal(p.resolve('telegram', '777').id, 'liam');
  // Re-binding the same pair to the same principal is idempotent.
  p.bind('liam', { channel: 'telegram', identity: '777' });
  assert.equal(p.get('liam')!.bindings.length, 1);
});

test('the same identity on a different channel is a separate binding', () => {
  const p = new Principals(dir());
  p.upsert(person());
  p.bind('liam', { channel: 'telegram', identity: '777' });
  p.bind('liam', { channel: 'discord', identity: '777' });
  assert.equal(p.get('liam')!.bindings.length, 2);
});

test('bind throws for an unknown principal', () => {
  const p = new Principals(dir());
  assert.throws(() => p.bind('nobody', { channel: 'web', identity: 'x@y.com' }), /unknown principal/);
});

test('upsert replaces an existing principal and fills missing collections', () => {
  const p = new Principals(dir());
  p.upsert(person({ name: 'Liam' }));
  p.bind('liam', { channel: 'discord', identity: '5' });
  const updated = p.upsert({ id: 'liam', name: 'Liam M', role: 'child' } as Principal);
  assert.equal(p.list().filter(x => x.id === 'liam').length, 1);
  assert.equal(updated.name, 'Liam M');
  assert.deepEqual(updated.grants, {});
  // An upsert that omits bindings keeps the ones already recorded, so editing a
  // principal from the dashboard does not silently unbind their chat accounts.
  assert.deepEqual(updated.bindings, [{ channel: 'discord', identity: '5' }]);
});

test('remove drops a principal and reports an unknown id', () => {
  const p = new Principals(dir());
  p.upsert(person());
  assert.equal(p.remove('liam'), true);
  assert.equal(p.get('liam'), undefined);
  assert.equal(p.remove('liam'), false);
});

test('remove refuses to delete the last owner', () => {
  const p = new Principals(dir());
  assert.throws(() => p.remove('owner'), /last owner/);
  p.upsert(person({ id: 'mag', name: 'Mag', role: 'owner' }));
  assert.equal(p.remove('owner'), true);
});

test('principals persist across instances', () => {
  const d = dir();
  const first = new Principals(d);
  first.upsert(person({ id: 'mag', name: 'Mag', role: 'adult', grants: { family: 'act', grocery: 'act' } }));
  first.bind('mag', { channel: 'telegram', identity: '4242' });

  const second = new Principals(d);
  assert.equal(second.list().length, 2);
  assert.equal(second.resolve('telegram', '4242').id, 'mag');
  assert.equal(second.can(second.get('mag')!, 'grocery', 'act'), true);
});

test('a corrupt principals.json falls back to a seeded owner rather than throwing', () => {
  const d = dir();
  writeFileSync(join(d, 'principals.json'), '{ not json');
  const p = new Principals(d);
  assert.equal(p.get('owner')?.role, 'owner');
});

test('seedFromConfig upserts config.principals and keeps the owner', () => {
  const d = dir();
  const p = new Principals(d);
  p.seedFromConfig(config({
    dataDir: d,
    principals: [
      { id: 'mag', name: 'Mag', role: 'adult', bindings: [{ channel: 'telegram', identity: '11' }], grants: { family: 'act' } },
      { id: 'liam', name: 'Liam', role: 'child', bindings: [], grants: { family: 'read' } },
    ],
  }));
  assert.deepEqual(p.list().map(x => x.id).sort(), ['liam', 'mag', 'owner']);
  assert.equal(p.resolve('telegram', '11').id, 'mag');
  assert.equal(new Principals(d).get('liam')?.role, 'child');
});

test('seedFromConfig is a no-op when the config lists no principals', () => {
  const d = dir();
  const p = new Principals(d);
  p.seedFromConfig(config({ dataDir: d }));
  assert.deepEqual(p.list().map(x => x.id), ['owner']);
});

test('identityFromHeaders reads the Cloudflare Access email, case-insensitively', () => {
  assert.equal(identityFromHeaders({ 'cf-access-authenticated-user-email': 'Mag@Example.com' }), 'mag@example.com');
  assert.equal(identityFromHeaders({ 'Cf-Access-Authenticated-User-Email': 'tendai@example.com' }), 'tendai@example.com');
  assert.equal(identityFromHeaders({ 'cf-access-authenticated-user-email': ['a@b.com', 'c@d.com'] }), 'a@b.com');
});

test('identityFromHeaders falls back to local when the Access header is absent or blank', () => {
  assert.equal(identityFromHeaders({}), 'local');
  assert.equal(identityFromHeaders({ 'cf-access-authenticated-user-email': '' }), 'local');
  assert.equal(identityFromHeaders({ 'cf-access-authenticated-user-email': '   ' }), 'local');
});
