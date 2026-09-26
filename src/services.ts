import { Ledger } from './ledger.js';
import { Principals } from './permissions.js';
import type { GombweConfig } from './types.js';

export interface Services {
  ledger: Ledger;
  principals: Principals;
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
    ownerName: config.identity.name,
    thirdPartyServers: thirdPartyServers(config),
  });
  principals.seedFromConfig(config);
  return { ledger: new Ledger(config.dataDir), principals };
}
