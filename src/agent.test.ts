import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpConfigArgs } from './agent.js';

/** What the gateway constructor pushes: the family server, declared inline. */
const family = JSON.stringify({ mcpServers: { 'gombwe-family': { command: 'node', args: ['family.js'] } } });
/** A third-party server an owner declared in gombwe.json. */
const puppeteer = JSON.stringify({ mcpServers: { puppeteer: { command: 'npx', args: ['puppeteer-mcp'] } } });

const SESSION = '/data/mcp/abc123.json';

test('no session config falls back to the configured household servers', () => {
  // This is what a cron job, a trigger or a workflow gets: gombwe acting as
  // itself, not on anyone's behalf.
  assert.deepEqual(
    mcpConfigArgs(undefined, [family, puppeteer]),
    ['--mcp-config', family, puppeteer],
  );
  assert.deepEqual(mcpConfigArgs({}, [family]), ['--mcp-config', family]);
});

test('nothing configured and no session config means no flag at all', () => {
  assert.deepEqual(mcpConfigArgs(undefined, undefined), []);
  assert.deepEqual(mcpConfigArgs({ mcpConfigs: [] }, []), []);
});

test('a confined session gets its own file and nothing else', () => {
  const args = mcpConfigArgs({ mcpConfigs: [SESSION], strictMcp: true }, [family, puppeteer]);
  assert.deepEqual(args, ['--mcp-config', SESSION, '--strict-mcp-config']);
  // The whole point: a child's session cannot reach the browser.
  assert.ok(!args.includes(puppeteer));
});

test('an owner session keeps the servers declared inline in gombwe.json', () => {
  const args = mcpConfigArgs({ mcpConfigs: [SESSION], strictMcp: false }, [family, puppeteer]);
  // The session file only names servers gombwe owns, so a third-party server
  // declared inline would vanish if the session file replaced the list.
  assert.deepEqual(args, ['--mcp-config', family, puppeteer, SESSION]);
  assert.ok(!args.includes('--strict-mcp-config'));
  // The session file goes last, so it wins any name it shares with them.
  assert.ok(args.lastIndexOf(SESSION) > args.lastIndexOf(family));
});

test('strict is never added without a session config to be strict about', () => {
  // With only the fallback configs it would cut the owner off from their own
  // servers, which is the opposite of what the flag is for.
  assert.deepEqual(mcpConfigArgs({ strictMcp: true }, [family]), ['--mcp-config', family]);
  assert.deepEqual(mcpConfigArgs({ mcpConfigs: [], strictMcp: true }, [family]), ['--mcp-config', family]);
});

test('mcpConfigArgs does not mutate what it is handed', () => {
  const configured = [family];
  const opts = { mcpConfigs: [SESSION], strictMcp: false };
  mcpConfigArgs(opts, configured);
  assert.deepEqual(configured, [family]);
  assert.deepEqual(opts.mcpConfigs, [SESSION]);
});
