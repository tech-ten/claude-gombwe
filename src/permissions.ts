/**
 * Who is asking, and what they are allowed to do.
 *
 * A principal is a household member (or a guest) with a stable id, a role, a
 * set of channel bindings that say how to recognise them, and per-connector
 * grants. Every surface — chat, dashboard, MCP — resolves the caller to a
 * principal first, then asks `can()`.
 *
 * Identity per channel:
 *   web       the Cloudflare Access email, or 'local' for a LAN request with
 *             no Access header. The seeded owner is bound to web/'local', so
 *             the dashboard on the home network is the owner — Access always
 *             sets the header when the request came in from outside.
 *   discord   the author's snowflake id
 *   telegram  the from-user id
 *
 * An identity that matches no binding resolves to a guest with no grants
 * rather than throwing, so an unknown chat account can be talked to safely
 * and is visible in the ledger by the id it resolved to.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GombweConfig } from './types.js';

export type Role = 'owner' | 'adult' | 'child' | 'guest';

export type Connector =
  | 'family' | 'network' | 'grocery' | 'desktop' | 'email'
  | 'calendar' | 'memory' | 'goals' | 'monitors';

export type Level = 'read' | 'act';

export interface Binding {
  channel: string;
  identity: string;
}

export interface Principal {
  id: string;
  name: string;
  role: Role;
  bindings: Binding[];
  grants: Partial<Record<Connector, Level>>;
}

export const CONNECTORS: Connector[] = [
  'family', 'network', 'grocery', 'desktop', 'email',
  'calendar', 'memory', 'goals', 'monitors',
];

export const ROLES: Role[] = ['owner', 'adult', 'child', 'guest'];

export const LEVELS: Level[] = ['read', 'act'];

const FILE = 'principals.json';
const OWNER_ID = 'owner';
const ACCESS_HEADER = 'cf-access-authenticated-user-email';

/** The identity a web request speaks for: its Access email, else 'local'. */
export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== ACCESS_HEADER) continue;
    const raw = (Array.isArray(value) ? value[0] : value) ?? '';
    const email = raw.trim().toLowerCase();
    if (email) return email;
  }
  return 'local';
}

export class Principals {
  private file: string;
  private principals: Principal[] = [];
  private thirdPartyServers: string[];

  constructor(
    dataDir: string,
    opts: { ownerName?: string; thirdPartyServers?: string[] } = {},
  ) {
    this.file = join(dataDir, FILE);
    this.thirdPartyServers = opts.thirdPartyServers ?? [];
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.load();
    if (!this.principals.some(p => p.role === 'owner')) {
      this.principals.push({
        id: OWNER_ID,
        name: opts.ownerName ? `${opts.ownerName} owner` : 'Owner',
        role: 'owner',
        bindings: [{ channel: 'web', identity: 'local' }],
        grants: {},
      });
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { principals?: unknown };
      if (!Array.isArray(parsed?.principals)) return;
      this.principals = parsed.principals
        .filter((p): p is Principal => !!p && typeof (p as Principal).id === 'string')
        .map(p => normalise(p));
    } catch {
      // A hand-edited or half-written file must not stop the gateway booting;
      // the constructor re-seeds an owner so the dashboard still has a way in.
      this.principals = [];
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ principals: this.principals }, null, 2));
    renameSync(tmp, this.file);
  }

  list(): Principal[] {
    return this.principals.map(clone);
  }

  get(id: string): Principal | undefined {
    const found = this.principals.find(p => p.id === id);
    return found ? clone(found) : undefined;
  }

  /**
   * Create or replace a principal. Omitted `grants` mean "none" (the edit form
   * always sends the full set), but omitted `bindings` keep the ones already
   * recorded — bindings are owned by `bind()`, so editing a role or a grant
   * must not silently unbind someone's chat accounts.
   */
  upsert(p: Principal): Principal {
    const next = normalise(p);
    const idx = this.principals.findIndex(x => x.id === next.id);
    if (idx >= 0) {
      if (!Array.isArray(p.bindings)) next.bindings = this.principals[idx].bindings;
      this.principals[idx] = next;
    } else {
      this.principals.push(next);
    }
    this.save();
    return clone(next);
  }

  remove(id: string): boolean {
    const idx = this.principals.findIndex(p => p.id === id);
    if (idx < 0) return false;
    // Without an owner every owner-only route — including the one that would
    // restore an owner — is closed, so the file would need hand-editing.
    if (this.principals[idx].role === 'owner' && this.principals.filter(p => p.role === 'owner').length === 1) {
      throw new Error('cannot remove the last owner');
    }
    this.principals.splice(idx, 1);
    this.save();
    return true;
  }

  /** Bind a channel identity to a principal, moving it off whoever held it. */
  bind(id: string, b: Binding): Principal {
    const target = this.principals.find(p => p.id === id);
    if (!target) throw new Error(`unknown principal: ${id}`);
    const channel = String(b.channel);
    const identity = String(b.identity);
    for (const p of this.principals) {
      p.bindings = p.bindings.filter(x => !(x.channel === channel && x.identity === identity));
    }
    target.bindings.push({ channel, identity });
    this.save();
    return clone(target);
  }

  resolve(channel: string, identity: string): Principal {
    const found = this.principals.find(p =>
      p.bindings.some(b => b.channel === channel && b.identity === identity));
    if (found) return clone(found);
    return {
      id: `guest:${channel}:${identity}`,
      name: identity,
      role: 'guest',
      bindings: [{ channel, identity }],
      grants: {},
    };
  }

  can(p: Principal, connector: Connector, level: Level): boolean {
    if (p.role === 'owner') return true;
    const grant = p.grants?.[connector];
    if (!grant) return false;
    return level === 'read' ? true : grant === 'act';
  }

  /**
   * The MCP servers this principal's agent session may load. Third-party
   * servers (browser control, cloud SDKs) stay owner-only: they reach outside
   * the household and have no per-connector grant to sit behind.
   */
  mcpServersFor(p: Principal): string[] {
    const servers = ['gombwe'];
    if (this.can(p, 'family', 'read')) servers.push('gombwe-family');
    if (p.role === 'owner') servers.push(...this.thirdPartyServers);
    return servers;
  }

  /** Upsert the principals declared in gombwe.json, if any. */
  seedFromConfig(config: GombweConfig): void {
    for (const p of config.principals ?? []) this.upsert(p);
  }
}

function clone(p: Principal): Principal {
  return { ...p, bindings: p.bindings.map(b => ({ ...b })), grants: { ...p.grants } };
}

function normalise(p: Principal): Principal {
  return {
    id: String(p.id),
    name: p.name ? String(p.name) : String(p.id),
    role: ROLES.includes(p.role) ? p.role : 'guest',
    bindings: (Array.isArray(p.bindings) ? p.bindings : [])
      .filter(b => b && b.channel && b.identity)
      .map(b => ({ channel: String(b.channel), identity: String(b.identity) })),
    grants: { ...(p.grants ?? {}) },
  };
}
