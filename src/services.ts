import { Approvals } from './approvals.js';
import { Ledger } from './ledger.js';
import { Memory } from './memory.js';
import { Principals } from './permissions.js';
import type { GombweConfig } from './types.js';

/**
 * A bearer token minted for one agent session, held in memory only.
 *
 * The token is the session's whole identity at the tool surface: the CLI child
 * process gets it in its environment and presents it on every tool call, so the
 * gateway knows which person that call is for without trusting anything the
 * child says. Nothing is persisted — a restart ends every session's tool
 * access, which is the right way round: a token that outlived the gateway would
 * outlive the roster it was checked against.
 */
export interface SessionToken {
  principalId: string;
  sessionKey: string;
  channel?: string;
  createdAt: string;
}

export interface Services {
  ledger: Ledger;
  principals: Principals;
  approvals: Approvals;
  memory: Memory;
  /** Keyed by the token itself. See `SessionToken`. */
  sessionTokens: Map<string, SessionToken>;
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
    sessionTokens: new Map(),
  };
}
