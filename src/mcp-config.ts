/**
 * A session's tool credentials: the bearer token it presents, and the
 * `--mcp-config` file that carries it.
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
import { chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowsConnector } from './gombwe-tools.js';
import type { Principal } from './permissions.js';
import type { SessionToken } from './services.js';
import type { GombweConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * How long a session's token and config file survive without the session being
 * spoken on. Long enough that a conversation picked up next weekend still works,
 * short enough that `data/mcp/` does not grow without bound.
 */
export const SESSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

/** Our own servers. Anything else in the list is a third-party name, not ours to write. */
const GOMBWE_SERVER = 'gombwe';
const FAMILY_SERVER = 'gombwe-family';

interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The bearer token for one session, minted or reused in place.
 *
 * One token per session key, reused across messages so the config file does not
 * need a fresh secret every turn. Reuse refreshes `createdAt`, which is
 * therefore "last handed out" — a conversation that runs for weeks must not be
 * pruned out from under a task still holding its token.
 *
 * If the person on the session changed, the old token is dropped rather than
 * re-pointed, so anything still holding it stops working rather than quietly
 * acting as the new person. `keepExisting` suppresses that for a
 * system-originated turn: gombwe resuming its own conversation must never
 * invalidate the credential the session was already using.
 */
export function sessionTokenFor(
  tokens: Map<string, SessionToken>,
  sessionKey: string,
  principalId: string,
  channel?: string,
  opts: { keepExisting?: boolean; ttlMs?: number; now?: () => Date } = {},
): string {
  const now = opts.now ?? (() => new Date());
  const stamp = now().toISOString();
  pruneSessionTokens(tokens, { ttlMs: opts.ttlMs, now });
  for (const [token, held] of tokens) {
    if (held.sessionKey !== sessionKey) continue;
    if (held.principalId === principalId) {
      held.channel = channel ?? held.channel;
      held.createdAt = stamp;
      return token;
    }
    if (!opts.keepExisting) tokens.delete(token);
  }
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { principalId, sessionKey, channel, createdAt: stamp });
  return token;
}

/** Forget tokens for sessions nobody has spoken on in a while. */
export function pruneSessionTokens(
  tokens: Map<string, SessionToken>,
  opts: { ttlMs?: number; now?: () => Date } = {},
): number {
  const cutoff = (opts.now ?? (() => new Date()))().getTime() - (opts.ttlMs ?? SESSION_TOKEN_TTL_MS);
  let dropped = 0;
  for (const [token, held] of tokens) {
    const at = Date.parse(held.createdAt);
    if (Number.isFinite(at) && at < cutoff) {
      tokens.delete(token);
      dropped++;
    }
  }
  return dropped;
}

/**
 * Delete config files for sessions long finished with.
 *
 * Every message writes one of these, so without a sweep the directory grows for
 * the life of the household. A file older than the token TTL cannot be in use:
 * the token inside it was pruned from memory at the same age, so the config
 * would fail on its first call anyway. The file just written is always newer
 * than the cutoff, so it is never its own victim.
 */
export function pruneSessionMcpConfigs(
  dataDir: string,
  opts: { ttlMs?: number; now?: () => Date } = {},
): number {
  const dir = join(dataDir, 'mcp');
  const cutoff = (opts.now ?? (() => new Date()))().getTime() - (opts.ttlMs ?? SESSION_TOKEN_TTL_MS);
  let dropped = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // nothing written yet
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.tmp')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs >= cutoff) continue;
      unlinkSync(file);
      dropped++;
    } catch {
      // A file another process removed mid-sweep is already what we wanted.
    }
  }
  return dropped;
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

  // Cheap enough to do on every write: one readdir over a directory holding at
  // most one file per live session. A sweep that fails must never fail the
  // write, because the config is what the session about to start depends on.
  try {
    pruneSessionMcpConfigs(dataDir);
  } catch (err) {
    console.error(`[mcp-config] could not sweep old session configs: ${err instanceof Error ? err.message : String(err)}`);
  }
  return path;
}
