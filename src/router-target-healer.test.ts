import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRouterTargets, startRouterTargetHealer, stopRouterTargetHealer, type RouterClient } from './router-target-healer.js';

interface Call { method: string; path: string; body?: unknown }

/** Fake RouterOS REST surface: serves GET fixtures, records every write. */
function fakeRouter(fixtures: Record<string, unknown>) {
  const calls: Call[] = [];
  const client: RouterClient = {
    async raw<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === 'GET') {
        if (!(path in fixtures)) throw new Error(`no fixture for GET ${path}`);
        return fixtures[path] as T;
      }
      return {} as T;
    },
  };
  const writes = () => calls.filter(c => c.method !== 'GET');
  return { client, calls, writes };
}

const MY_IP = '192.168.88.118';

const healthyFixtures = {
  '/system/logging/action': [{ '.id': '*3', name: 'remote', remote: MY_IP, 'remote-port': '1514' }],
  '/system/logging': [{ '.id': '*A', topics: 'dns,packet', action: 'remote', disabled: 'false' }],
  '/ip/traffic-flow/target': [{ '.id': '*1', 'dst-address': MY_IP, port: '2055', version: '9' }],
};

test('leaves the router untouched when both targets already point at this host', async () => {
  const r = fakeRouter(healthyFixtures);
  const status = await ensureRouterTargets(r.client, MY_IP);
  assert.equal(r.writes().length, 0);
  assert.ok(status.every(s => s.startsWith('ok')), status.join(' | '));
});

test('repoints the dns log action and re-initialises dns rules when the target is stale', async () => {
  const r = fakeRouter({
    ...healthyFixtures,
    '/system/logging/action': [{ '.id': '*3', name: 'remote', remote: '192.168.88.123', 'remote-port': '1514' }],
  });
  await ensureRouterTargets(r.client, MY_IP);
  const w = r.writes();
  assert.deepEqual(w[0], { method: 'PATCH', path: '/system/logging/action/*3', body: { remote: MY_IP, 'remote-port': '1514' } });
  assert.deepEqual(w.slice(1).map(c => [c.path, (c.body as { disabled: string }).disabled]),
    [['/system/logging/*A', 'yes'], ['/system/logging/*A', 'no']]);
});

test('repoints the netflow target when it is stale', async () => {
  const r = fakeRouter({
    ...healthyFixtures,
    '/ip/traffic-flow/target': [{ '.id': '*1', 'dst-address': '192.168.88.226', port: '2055', version: '9' }],
  });
  const status = await ensureRouterTargets(r.client, MY_IP);
  assert.deepEqual(r.writes(), [{ method: 'PATCH', path: '/ip/traffic-flow/target/*1', body: { 'dst-address': MY_IP } }]);
  assert.ok(status.some(s => s.includes('netflow') && s.includes('192.168.88.226 -> ' + MY_IP)), status.join(' | '));
});

test('reports a skip rather than failing when the router has no netflow target', async () => {
  const r = fakeRouter({ ...healthyFixtures, '/ip/traffic-flow/target': [] });
  const status = await ensureRouterTargets(r.client, MY_IP);
  assert.equal(r.writes().length, 0);
  assert.ok(status.some(s => s.startsWith('skipped') && s.includes('netflow')), status.join(' | '));
});

test('a non-owner instance never touches the router', async () => {
  const r = fakeRouter(healthyFixtures);
  startRouterTargetHealer({ owner: false, client: r.client, myIp: () => MY_IP });
  await new Promise(res => setTimeout(res, 20));
  stopRouterTargetHealer();
  assert.equal(r.calls.length, 0);
});

test('the owner instance checks the router immediately on start', async () => {
  const r = fakeRouter(healthyFixtures);
  startRouterTargetHealer({ owner: true, client: r.client, myIp: () => MY_IP });
  await new Promise(res => setTimeout(res, 20));
  stopRouterTargetHealer();
  assert.ok(r.calls.some(c => c.path === '/ip/traffic-flow/target'), 'netflow target was not checked');
  assert.ok(r.calls.some(c => c.path === '/system/logging/action'), 'dns log target was not checked');
});
