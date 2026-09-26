/**
 * Ledger posting for the family MCP server.
 *
 * The MCP server is a separate child process spawned by the Claude CLI, so it
 * cannot reach the gateway's in-process `Ledger`. It posts to the gateway's
 * loopback-only `POST /api/ledger` instead — the same route background scripts
 * use via `postLedger` in `scripts/grocery-lib.mjs`.
 *
 * Nothing here ever throws or rejects. A family tool that changed
 * `family.json` has already succeeded; failing to record it must not turn a
 * successful tool call into an error the user sees.
 */
import type { LedgerActor, LedgerOutcome } from '../ledger.js';

export interface FamilyLedgerEntry {
  action: string;
  actor?: LedgerActor;
  principal?: string;
  target?: string;
  params?: Record<string, unknown>;
  outcome?: LedgerOutcome;
  receipt?: Record<string, unknown>;
  error?: string;
}

export interface PostLedgerOptions {
  port?: string | number;
  fetchImpl?: typeof fetch;
}

/**
 * Whoever is talking to this MCP server. The gateway stamps the session's
 * principal into the child's environment; a bare `claude` invocation on this
 * machine has none, and that is the owner at the keyboard.
 */
export function ledgerPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.GOMBWE_PRINCIPAL?.trim();
  return value ? value : 'owner';
}

/** POST one entry to the gateway. Returns the stored entry, or null on any failure. */
export async function postLedger(
  entry: FamilyLedgerEntry,
  { port = process.env.GOMBWE_PORT || '18790', fetchImpl = fetch }: PostLedgerOptions = {},
): Promise<Record<string, unknown> | null> {
  const body = {
    actor: 'chat' as LedgerActor,
    principal: ledgerPrincipal(),
    outcome: 'ok' as LedgerOutcome,
    ...entry,
  };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[mcp-family] ledger endpoint returned ${res.status} for ${body.action}`);
      return null;
    }
    return await res.json() as Record<string, unknown>;
  } catch (err: any) {
    console.error(`[mcp-family] could not record ${body.action} in the ledger: ${err?.message}`);
    return null;
  }
}
