/**
 * The per-session `--mcp-config` file.
 *
 * Every agent session gets its own file naming only the servers that session's
 * principal may load, with a bearer token minted for that session in the
 * environment. That is what makes the grants real at the tool surface: a child's
 * session is handed a config with one server in it, and with
 * `--strict-mcp-config` the CLI loads nothing else — not the family server, not
 * the browser, not the cloud SDKs sitting in `~/.claude.json`.
 *
 * The file is named by sha1 of the session key, so the same conversation reuses
 * the same path across messages and a long or punctuation-heavy key (a Discord
 * channel id, a web tab) cannot produce an awkward filename.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowsConnector } from './gombwe-tools.js';
import type { Principal } from './permissions.js';
import type { GombweConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Our own servers. Anything else in the list is a third-party name, not ours to write. */
const GOMBWE_SERVER = 'gombwe';
const FAMILY_SERVER = 'gombwe-family';

interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Where this session's config lives, without creating anything. */
export function sessionMcpConfigPath(dataDir: string, sessionKey: string): string {
  const hash = createHash('sha1').update(String(sessionKey)).digest('hex');
  return join(dataDir, 'mcp', `${hash}.json`);
}

/**
 * Write the config for one session and return its path.
 *
 * `servers` is the allow-list from `Principals.mcpServersFor`. The family server
 * is additionally re-checked against the principal's own grant here, so a caller
 * that assembles the list by hand cannot widen what a session reaches.
 */
export function writeSessionMcpConfig(
  config: GombweConfig,
  dataDir: string,
  sessionKey: string,
  principal: Principal,
  token: string,
  servers: string[],
): string {
  const path = sessionMcpConfigPath(dataDir, sessionKey);
  // Every file in here holds a live bearer token, so the directory is this
  // user's alone — chmod as well as mode, because it may already exist.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const allowed = new Set(servers ?? []);
  const mcpServers: Record<string, McpServerSpec> = {
    // Always present: this is how the session reaches memory, approvals and the
    // ledger, and a session with no tools at all has no way to ask for consent.
    [GOMBWE_SERVER]: {
      command: 'node',
      args: [join(__dirname, 'mcp', 'gombwe.js')],
      env: {
        GOMBWE_PORT: String(config.port),
        GOMBWE_SESSION_TOKEN: token,
        GOMBWE_PRINCIPAL: principal.id,
        GOMBWE_SESSION_KEY: String(sessionKey),
      },
    },
  };

  if (allowed.has(FAMILY_SERVER) && allowsConnector(principal, 'family', 'read')) {
    mcpServers[FAMILY_SERVER] = {
      command: 'node',
      args: [join(__dirname, 'mcp', 'family.js')],
      env: {
        GOMBWE_DATA_DIR: config.dataDir,
        GOMBWE_PORT: String(config.port),
      },
    };
  }

  // Written through a temp file so a session starting mid-write never reads a
  // half-written config, and 0600 because the token in it is a bearer credential.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}
