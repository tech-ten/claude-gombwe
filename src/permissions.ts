/**
 * Who is asking, and what they are allowed to do.
 *
 * A principal is a household member (or a guest) with a stable id, a role, a
 * set of channel bindings that say how to recognise them, and per-connector
 * grants. Every surface — chat, dashboard, MCP — resolves the caller to a
 * principal first, then asks `can()`.
 *
 * Identity per channel:
 *   web       the Cloudflare Access email; failing that, 'local' for a request
 *             from this machine (which is what a tunnelled request looks like
 *             on the way in), or 'lan:<ip>' for anything else on the network.
 *             The seeded owner is bound to web/'local', so a LAN device with no
 *             Access header is a guest rather than the owner.
 *   discord   the author's snowflake id
 *   telegram  the from-user id
 *
 * An identity that matches no binding resolves to a guest with no grants
 * rather than throwing, so an unknown chat account can be talked to safely
 * and is visible in the ledger by the id it resolved to.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GombweConfig, IncomingMessage, Session } from './types.js';

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

/** Socket address with the IPv6 mapping and any zone id taken off. */
function normaliseAddress(remoteAddress?: string): string {
  const addr = String(remoteAddress ?? '').trim().toLowerCase().split('%')[0];
  return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

/** Is this address this machine talking to itself? */
export function isLoopback(remoteAddress?: string): boolean {
  const addr = normaliseAddress(remoteAddress);
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return addr === '::1' || addr === 'localhost' || /^127\./.test(addr);
}

/**
 * Headers that mean a request came through Cloudflare rather than from a
 * process on this machine. cloudflared delivers tunnel traffic to 127.0.0.1,
 * so any of these on a loopback socket says "someone off the network", and
 * `cf-ray` is present even on a route with no Access policy in front of it.
 */
const PROXY_HEADERS = [
  ACCESS_HEADER,
  'cf-access-jwt-assertion',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-for',
];

/**
 * Is this a process on this machine talking to the gateway directly?
 *
 * `isLoopback` alone is not enough for a route that must never be reachable
 * from outside: the tunnel's own traffic arrives on loopback too, so every
 * person on the Access allow-list would pass it. A request that carries any
 * Cloudflare header was proxied and is refused, which costs nothing — a local
 * script sends none of them.
 */
export function isLocalProcessRequest(
  headers: Record<string, string | string[] | undefined> | undefined,
  remoteAddress?: string,
): boolean {
  if (!isLoopback(remoteAddress)) return false;
  for (const key of Object.keys(headers ?? {})) {
    if (PROXY_HEADERS.includes(key.toLowerCase())) return false;
  }
  return true;
}

/**
 * The identity a web request speaks for.
 *
 * The Access email wins wherever the request came from. Without one, only a
 * request from this machine is 'local' — the identity the owner is bound to —
 * because a request off the network arrives through cloudflared on loopback and
 * a real LAN client does not. Everything else on the network is named by its
 * address, `lan:192.168.1.50`, which is bound to nobody and therefore a guest:
 * a device on the home Wi-Fi must not be able to approve a payment.
 *
 * An address we could not read at all is `lan:unknown`, which fails closed for
 * the same reason.
 */
export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== ACCESS_HEADER) continue;
    const raw = (Array.isArray(value) ? value[0] : value) ?? '';
    const email = raw.trim().toLowerCase();
    if (email) return email;
  }
  if (isLoopback(remoteAddress)) return 'local';
  return `lan:${normaliseAddress(remoteAddress) || 'unknown'}`;
}

/**
 * The principal an incoming message speaks for, given the session it lands in.
 *
 * A system message is gombwe talking to itself — an approval decision feeding
 * back into a conversation minutes after the agent stopped. Its `sender` is
 * 'system', which is bound to nobody, so resolving it the ordinary way would
 * turn a child's conversation into a guest's for one turn: no memory tools, no
 * family server, and a freshly minted token that invalidates the one the
 * session was already holding. So a system message speaks for whoever was last
 * here instead.
 *
 * Everything else resolves by channel identity, as always. A session whose
 * person has since been removed from the roster falls through to that, which is
 * the point: someone taken off the roster does not keep acting through a resume.
 */
export function sessionPrincipalFor(
  session: Session | undefined,
  msg: Pick<IncomingMessage, 'channel' | 'sender' | 'system'>,
  principals: Principals,
): Principal {
  const held = msg.system ? session?.principal : undefined;
  if (held) {
    const known = principals.get(held);
    if (known) return known;
    // Nobody on the roster, so this session belonged to a guest. Keep their id
    // rather than resolving 'system' into a second, different guest — the
    // grants are the same either way, but the token is not.
    if (held.startsWith('guest:')) {
      return { id: held, name: held, role: 'guest', bindings: [], grants: {} };
    }
  }
  return principals.resolve(msg.channel, msg.sender || 'unknown');
}

export class Principals {
  private file: string;
  private principals: Principal[] = [];
  private thirdPartyServers: string[];

  constructor(
    dataDir: string,
    opts: { thirdPartyServers?: string[] } = {},
  ) {
    this.file = join(dataDir, FILE);
    this.thirdPartyServers = opts.thirdPartyServers ?? [];
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.load();
    this.ensureOwner();
  }

  /**
   * There must always be exactly one record with the reserved `owner` id, and
   * at least one principal with the owner role. A roster that lost its owner —
   * hand-edited, or written by a build before `upsert` refused the demotion —
   * is repaired in place: pushing a second `owner` record would shadow the
   * first and silently split one person into two.
   */
  private ensureOwner(): void {
    if (this.principals.some(p => p.role === 'owner')) return;
    const existing = this.principals.find(p => p.id === OWNER_ID);
    if (existing) {
      existing.role = 'owner';
      // Only claim web/local if nobody else holds it, so repairing the roster
      // cannot quietly take a binding off another principal.
      const heldElsewhere = this.principals.some(p =>
        p.id !== OWNER_ID && p.bindings.some(b => b.channel === 'web' && b.identity === 'local'));
      if (!heldElsewhere && !existing.bindings.some(b => b.channel === 'web' && b.identity === 'local')) {
        existing.bindings.push({ channel: 'web', identity: 'local' });
      }
    } else {
      this.principals.push({
        id: OWNER_ID,
        name: 'Owner',
        role: 'owner',
        bindings: [{ channel: 'web', identity: 'local' }],
        grants: {},
      });
    }
    this.save();
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
   *
   * Bindings that are supplied move, exactly as `bind()` moves them: a
   * channel identity is held by one principal, never two, or `resolve` would
   * answer with whichever record happened to be listed first.
   */
  upsert(p: Principal): Principal {
    const next = normalise(p);
    const idx = this.principals.findIndex(x => x.id === next.id);
    // Demoting the only owner closes every owner-only route, including the one
    // that would put the role back.
    const ownersAfter = this.principals.filter(x => x.id !== next.id && x.role === 'owner').length
      + (next.role === 'owner' ? 1 : 0);
    if (ownersAfter === 0 && idx >= 0 && this.principals[idx].role === 'owner') {
      throw new Error('cannot demote the last owner');
    }
    if (idx >= 0 && !Array.isArray(p.bindings)) {
      next.bindings = this.principals[idx].bindings;
    } else {
      for (const b of next.bindings) this.releaseBinding(b, next.id);
    }
    if (idx >= 0) this.principals[idx] = next;
    else this.principals.push(next);
    this.save();
    return clone(next);
  }

  /** Take a channel identity off every principal but `keepId`. */
  private releaseBinding(b: Binding, keepId: string): void {
    for (const p of this.principals) {
      if (p.id === keepId) continue;
      p.bindings = p.bindings.filter(x => !(x.channel === b.channel && x.identity === b.identity));
    }
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
    const binding = normaliseBinding(b);
    this.releaseBinding(binding, id);
    target.bindings = target.bindings
      .filter(x => !(x.channel === binding.channel && x.identity === binding.identity))
      .concat(binding);
    this.save();
    return clone(target);
  }

  resolve(channel: string, identity: string): Principal {
    const wanted = normaliseBinding({ channel, identity });
    const found = this.principals.find(p =>
      p.bindings.some(b => b.channel === wanted.channel && b.identity === wanted.identity));
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
    for (const p of config.principals ?? []) {
      try {
        this.upsert(p);
      } catch (err) {
        // One unusable entry (a config that demotes the owner) must not stop
        // the gateway booting — the rest of the roster still loads.
        console.error(`[principals] skipped ${p?.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function clone(p: Principal): Principal {
  return { ...p, bindings: p.bindings.map(b => ({ ...b })), grants: { ...p.grants } };
}

/**
 * Web identities are Cloudflare Access emails, which arrive lowercased from
 * `identityFromHeaders`. A binding typed in with capitals would never match, so
 * the case is flattened on the way in and on every lookup.
 */
function normaliseBinding(b: Binding): Binding {
  const channel = String(b.channel);
  const identity = String(b.identity);
  return { channel, identity: channel === 'web' ? identity.toLowerCase() : identity };
}

function normalise(p: Principal): Principal {
  return {
    id: String(p.id),
    name: p.name ? String(p.name) : String(p.id),
    role: ROLES.includes(p.role) ? p.role : 'guest',
    bindings: (Array.isArray(p.bindings) ? p.bindings : [])
      .filter(b => b && b.channel && b.identity)
      .map(normaliseBinding),
    grants: { ...(p.grants ?? {}) },
  };
}

/**
 * Every mutating `/api/network/*` route and the ledger action it records.
 * Paths are relative to the mount point; `:name` segments become params.
 */
export const NETWORK_ACTIONS: Array<{ method: string; path: string; action: string }> = [
  { method: 'POST',   path: '/devices/:mac/block',            action: 'network.device.block' },
  { method: 'POST',   path: '/devices/:mac/unblock',          action: 'network.device.unblock' },
  { method: 'POST',   path: '/devices/:mac/name',             action: 'network.device.name' },
  { method: 'POST',   path: '/devices/:mac/owner',            action: 'network.device.owner' },
  { method: 'POST',   path: '/devices/:mac/kid',              action: 'network.device.kid' },
  { method: 'PUT',    path: '/devices/:mac/policy',           action: 'network.policy.put' },
  { method: 'POST',   path: '/screentime/:mac/allow',         action: 'network.screentime.allow' },
  { method: 'POST',   path: '/screentime/:mac/block',         action: 'network.screentime.block' },
  { method: 'POST',   path: '/screentime/:mac/resume',        action: 'network.screentime.resume' },
  { method: 'PUT',    path: '/screentime/:mac/schedule',      action: 'network.screentime.schedule' },
  { method: 'POST',   path: '/firewall/:id/toggle',           action: 'network.firewall.toggle' },
  { method: 'DELETE', path: '/firewall/:id',                  action: 'network.firewall.delete' },
  { method: 'POST',   path: '/adlist',                        action: 'network.adlist.add' },
  { method: 'DELETE', path: '/adlist/:id',                    action: 'network.adlist.delete' },
  { method: 'POST',   path: '/adlist/refresh',                action: 'network.adlist.refresh' },
  { method: 'POST',   path: '/nat/port-forward',              action: 'network.nat.add' },
  { method: 'DELETE', path: '/nat/:id',                       action: 'network.nat.delete' },
  { method: 'POST',   path: '/dhcp-leases',                   action: 'network.dhcp.add' },
  { method: 'DELETE', path: '/dhcp-leases/:id',               action: 'network.dhcp.delete' },
  { method: 'POST',   path: '/dhcp-leases/:id/make-static',   action: 'network.dhcp.static' },
  { method: 'POST',   path: '/mt-raw',                        action: 'network.mt.raw' },
  { method: 'POST',   path: '/strands/cut',                   action: 'network.strands.cut' },
  { method: 'POST',   path: '/strands/reconnect',             action: 'network.strands.reconnect' },
  { method: 'POST',   path: '/dns-guard',                     action: 'network.dns-guard' },
  { method: 'DELETE', path: '/router-timers/:id',             action: 'network.router-timer.delete' },
  { method: 'POST',   path: '/schedules',                     action: 'network.schedule.add' },
  { method: 'PUT',    path: '/schedules/:id',                 action: 'network.schedule.update' },
  { method: 'DELETE', path: '/schedules/:id',                 action: 'network.schedule.delete' },
  { method: 'POST',   path: '/policy/scan',                   action: 'network.policy.scan' },
  { method: 'POST',   path: '/category-enforcer/test',        action: 'network.category-enforcer.test' },
  { method: 'POST',   path: '/blocklist-cache/refresh',       action: 'network.blocklist-cache.refresh' },
  { method: 'POST',   path: '/categories',                    action: 'network.categories.update' },
  { method: 'POST',   path: '/history/rollup/:date',          action: 'network.history.rollup' },
];

/** Match a mutating network request against the table above. */
export function matchNetworkAction(
  method: string,
  path: string,
): { action: string; params: Record<string, string> } | undefined {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  for (const route of NETWORK_ACTIONS) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pattern[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { action: route.action, params };
  }
  return undefined;
}
