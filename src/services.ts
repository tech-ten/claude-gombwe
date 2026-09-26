import { Approvals } from './approvals.js';
import { Ledger } from './ledger.js';
import { Memory } from './memory.js';
import { Principals } from './permissions.js';
import type { GombweConfig } from './types.js';

export interface Services {
  ledger: Ledger;
  principals: Principals;
  approvals: Approvals;
  memory: Memory;
}

/**
 * Every MCP server name the agent is configured with that is not one of ours.
 * These reach outside the household, so `mcpServersFor` keeps them owner-only.
 */
function thirdPartyServers(config: GombweConfig): string[] {
  const names = new Set<string>();
  for (const raw of config.agents.mcpConfigs ?? []) {
    try {
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      for (const name of Object.keys(parsed?.mcpServers ?? {})) {
        if (!name.startsWith('gombwe')) names.add(name);
      }
    } catch {
      // An mcpConfigs entry can also be a path to a config file rather than
      // inline JSON; those contribute no names here.
    }
  }
  return [...names];
}

export function createServices(config: GombweConfig): Services {
  const principals = new Principals(config.dataDir, {
    thirdPartyServers: thirdPartyServers(config),
  });
  principals.seedFromConfig(config);
  const ledger = new Ledger(config.dataDir);
  return {
    ledger,
    principals,
    approvals: new Approvals(config.dataDir, ledger, principals),
    memory: new Memory(config.dataDir),
  };
}
