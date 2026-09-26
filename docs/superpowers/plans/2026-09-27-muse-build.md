# Gombwe Household Agent (Muse + Apple parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn gombwe into the household agent described in the spec: ledger, approvals, principals and grants, household memory with reflection, deterministic monitors, goals, gated desktop and grocery actions, WhatsApp and inbound email channels, a remote MCP endpoint for the Claude app, and a finished dashboard.

**Architecture:** All new subsystems are modules under `src/` inside the existing gateway process, each owning one JSON/JSONL file in the data dir. The gateway is the single writer of the new stores. One tool registry (`src/gombwe-tools.ts`) is exposed three ways: in-process to gateway routes, over stdio to the Claude CLI via a thin HTTP-forwarding MCP server (`src/mcp/gombwe.ts`), and over Streamable HTTP to the Claude app (`src/remote-mcp.ts`). Every side effect goes through the ledger; sensitive classes block on approvals.

**Tech Stack:** TypeScript (ESM, `tsc`), Node 22, Express 5, `ws`, `@modelcontextprotocol/sdk` 1.29, `croner`, `node --test` with `tsx`. New deps: `mailparser`, `jose` (Access JWT verification). No new paid services.

**Spec:** `docs/superpowers/specs/2026-09-27-muse-parity-design.md`

## Global Constraints

- Inference stays on the Claude Code CLI under Claude Max. No provider abstraction, no paid inference or media APIs.
- Free tiers and owned infrastructure only (WhatsApp Cloud API free tier, AWS SES on the existing account, Cloudflare Tunnel and Access).
- Nothing is claimed working until tested. No simulated capabilities.
- This machine is a dev machine. Tests and smoke runs use a temp data dir (`mkdtemp`) and a random port. Never set `routerOwner`. Never start a daemon that talks to the MikroTik.
- Never access real household data files, real mailboxes, carts, or send anything externally in tests.
- Commit messages: plain imperative subject, no Co-Authored-By trailer.
- Every task is its own branch off `main`, merged back with `--no-ff` only when `npm run build && npm test` are green, then pushed and deleted.
- Data dir layout is fixed by `config.dataDir`; new files live directly under it: `memory.json`, `tombstones.json`, `ledger.jsonl`, `approvals.json`, `principals.json`, `goals.json`, `monitors.json`, `monitors/<id>/`, `inbox/<id>/`, `mcp/<hash>.json`.
- UI copy: plain English, no exclamation marks, no emoji in the dashboard.

## Branch protocol (every task)

```bash
cd /Users/tendaimudavanhu/code/claude-gombwe
git checkout main && git pull -q origin main
git checkout -b <branch>
# ... work, commit as you go ...
npm run build && npm test
git checkout main && git merge --no-ff <branch> -m "Merge <branch>: <one line>"
git push -q origin main
git branch -d <branch>
```

Every task also updates the docs it affects (README section, `docs/developer.md` once it exists, `CHANGELOG.md` once it exists) in the same branch.

## File structure

| File | Responsibility |
|---|---|
| `src/ledger.ts` | Append-only action ledger, fold-by-id reads, rotation |
| `src/permissions.ts` | Principals, bindings, grants, guest resolution, MCP server allow-list per principal |
| `src/approvals.ts` | Approval policy table, request/decide/wait/expire state machine, events |
| `src/memory.ts` | Household memory store, tombstones, recall, context block |
| `src/monitors.ts` | url/file/email monitors, snapshot hash diffing, scheduling |
| `src/goals.ts` | Goal store and engine: plan, run steps, wait on monitors, restart resume |
| `src/reflection.ts` | Nightly reflection job and daily suggestion |
| `src/desktop.ts` | AppleScript/shell classification and execution |
| `src/gombwe-tools.ts` | Single tool registry (schemas + handlers) used by routes, stdio MCP, remote MCP |
| `src/mcp/gombwe.ts` | stdio MCP server forwarding tool calls to the gateway over loopback |
| `src/remote-mcp.ts` | Streamable HTTP MCP endpoint with Cloudflare Access JWT verification |
| `src/channels/whatsapp.ts` | WhatsApp Cloud API adapter |
| `src/channels/email-in.ts` | SES/S3 inbound mail poller and SES outbound |
| `src/services.ts` | Constructs and wires all the above for the gateway (keeps gateway.ts from growing) |
| `src/gateway.ts` | Routes and message handling; delegates to services |
| `ui/` | Dashboard |
| `docs/adr/` | Architecture decision records |
| `docs/` | developer, user, magret, investor, roadmap, setup guides |

---

### Task 1: CI, doc reorganisation, retire Apple launcher

**Branch:** `ci-and-doc-reorg`

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `CHANGELOG.md`
- Move: `docs/Apple_Event_September_9th_2026.md`, `docs/apple-event-complete-matrix.md`, `docs/apple-event-feature-inventory.md`, `docs/gombwe-current-capability-audit.md`, `docs/gombwe-build-scope.csv`, `docs/gombwe-build-plan.md`, `docs/gombwe-personal-assistant-build.md` → `docs/reference/apple-event/`
- Delete: `scripts/start-personal-assistant-build.mjs`, `scripts/start-personal-assistant-build.test.mjs`, `docs/gombwe-personal-assistant-launch.md`, `docs/gombwe-mobile-expert-team-prompt.md`
- Keep the untracked `scripts/chromebook-guard.mjs` and the modified `skills/school-calendar-sync/SKILL.md` out of this branch (they are unrelated working changes; leave them in the working tree untouched).

- [ ] **Step 1: Create the workflow**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to gombwe. Versions follow semver; releases are git tags.

## [Unreleased]

### Added
- CI workflow: build and test on every push and pull request.

### Changed
- Apple event packet moved to `docs/reference/apple-event/`; launcher script retired in favour of the household-agent spec and plan.
```

- [ ] **Step 3: Move and delete files with `git mv` / `git rm`**, add a one-paragraph `docs/reference/apple-event/README.md` saying these are reference inputs superseded by the 2026-09-27 spec.

- [ ] **Step 4: Fix links** in the moved files that point at each other (they use relative links like `apple-event-feature-inventory.md`; they still resolve inside the same folder) and any links to `../src/...` become `../../../src/...`. Run `grep -n "](\.\./" docs/reference/apple-event/*.md` and fix each.

- [ ] **Step 5: Build, test, merge, push** per the branch protocol.

---

### Task 2: Action ledger

**Branch:** `ledger`

**Files:**
- Create: `src/ledger.ts`, `src/ledger.test.ts`
- Modify: `src/types.ts` (append types), `src/gateway.ts` (route)

**Interfaces:**
- Produces:

```ts
export type LedgerActor = 'chat'|'task'|'cron'|'trigger'|'goal'|'monitor'|'dashboard'|'skill'|'script'|'remote'|'system';
export type LedgerOutcome = 'ok'|'failed'|'denied'|'pending'|'expired';
export interface LedgerEntry {
  id: string; time: string; actor: LedgerActor; principal: string;
  action: string; target?: string; params?: Record<string, unknown>;
  outcome: LedgerOutcome; approvalId?: string; receipt?: Record<string, unknown>;
  sessionKey?: string; taskId?: string; goalId?: string; error?: string;
}
export interface LedgerFilter { actor?: LedgerActor; action?: string; outcome?: LedgerOutcome; since?: string; limit?: number; principal?: string }
export class Ledger {
  constructor(dataDir: string, opts?: { rotateBytes?: number });
  record(entry: Omit<LedgerEntry,'id'|'time'> & { id?: string; time?: string }): LedgerEntry;
  update(id: string, patch: Partial<Pick<LedgerEntry,'outcome'|'receipt'|'error'|'approvalId'>>): LedgerEntry | undefined;
  get(id: string): LedgerEntry | undefined;
  list(filter?: LedgerFilter): LedgerEntry[];   // newest first, folded by id (last line wins)
}
```

- [ ] **Step 1: Write failing tests** `src/ledger.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.js';

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-ledger-'));

test('record appends a line and list returns newest first', () => {
  const d = dir(); const l = new Ledger(d);
  const a = l.record({ actor: 'chat', principal: 'tendai', action: 'family.grocery.add', outcome: 'ok' });
  const b = l.record({ actor: 'cron', principal: 'system', action: 'reflection.run', outcome: 'ok' });
  const lines = readFileSync(join(d, 'ledger.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(l.list().map(e => e.id), [b.id, a.id]);
});

test('update appends a superseding line and list folds by id', () => {
  const d = dir(); const l = new Ledger(d);
  const e = l.record({ actor: 'script', principal: 'tendai', action: 'grocery.checkout', outcome: 'pending' });
  l.update(e.id, { outcome: 'ok', receipt: { order: '123', total: 84.2 } });
  const all = l.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].outcome, 'ok');
  assert.equal(all[0].receipt?.order, '123');
  assert.equal(readFileSync(join(d, 'ledger.jsonl'), 'utf-8').trim().split('\n').length, 2);
});

test('list filters by actor, action prefix, outcome, since, limit', () => {
  const d = dir(); const l = new Ledger(d);
  l.record({ actor: 'chat', principal: 'mag', action: 'family.meal.set', outcome: 'ok', time: '2026-09-01T00:00:00Z' });
  l.record({ actor: 'dashboard', principal: 'tendai', action: 'network.device.block', outcome: 'denied', time: '2026-09-20T00:00:00Z' });
  l.record({ actor: 'dashboard', principal: 'tendai', action: 'network.device.unblock', outcome: 'ok', time: '2026-09-21T00:00:00Z' });
  assert.equal(l.list({ actor: 'dashboard' }).length, 2);
  assert.equal(l.list({ action: 'network.' }).length, 2);
  assert.equal(l.list({ outcome: 'denied' }).length, 1);
  assert.equal(l.list({ since: '2026-09-15T00:00:00Z' }).length, 2);
  assert.equal(l.list({ limit: 1 }).length, 1);
});

test('reloads from disk on construction', () => {
  const d = dir();
  new Ledger(d).record({ actor: 'chat', principal: 'tendai', action: 'x', outcome: 'ok' });
  assert.equal(new Ledger(d).list().length, 1);
});

test('rotates when file exceeds rotateBytes', () => {
  const d = dir(); const l = new Ledger(d, { rotateBytes: 300 });
  for (let i = 0; i < 10; i++) l.record({ actor: 'chat', principal: 'tendai', action: 'a'.repeat(50), outcome: 'ok' });
  const rotated = existsSync(join(d, 'ledger.jsonl')) && require('node:fs').readdirSync(d).some((f: string) => /^ledger-\d{8}T\d{6}\.jsonl$/.test(f));
  assert.ok(rotated);
  assert.ok(l.list().length >= 1);
});
```

Use `import { readdirSync } from 'node:fs'` rather than `require` in the last test (ESM).

- [ ] **Step 2: Run to verify failure** `npm test -- src/ledger.test.ts` (or `node --import tsx --test src/ledger.test.ts`). Expected: cannot find module `./ledger.js`.

- [ ] **Step 3: Implement `src/ledger.ts`**

Key points: keep an in-memory `Map<string, LedgerEntry>` plus an insertion-ordered id list; on construct, read `ledger.jsonl` and the newest `ledger-*.jsonl` (previous file) if present; `record` assigns `randomUUID()` and ISO time, appends the JSON line, sets map; `update` merges and appends the full merged entry as a new line; `list` sorts by time desc then applies filter; rotation: before append, if `statSync(file).size > rotateBytes` (default 50 MB) rename to `ledger-<YYYYMMDDTHHmmss>.jsonl`. `action` filter is a prefix match.

- [ ] **Step 4: Types**: append the `Ledger*` types to `src/types.ts` (export from `ledger.ts` and re-export from types is fine; keep one definition in `ledger.ts`).

- [ ] **Step 5: Route** in `gateway.ts` `setupRoutes`:

```ts
this.app.get('/api/ledger', (req, res) => {
  const { actor, action, outcome, since, principal } = req.query as Record<string, string | undefined>;
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
  res.json(this.services.ledger.list({ actor: actor as any, action, outcome: outcome as any, since, principal, limit }));
});
```

Introduce `src/services.ts` now with just the ledger:

```ts
import { Ledger } from './ledger.js';
import type { GombweConfig } from './types.js';
export interface Services { ledger: Ledger }
export function createServices(config: GombweConfig): Services {
  return { ledger: new Ledger(config.dataDir) };
}
```

and in the Gateway constructor `this.services = createServices(config);` before `setupRoutes()`. Later tasks extend `Services`.

- [ ] **Step 6: Run tests, build, commit** `git commit -m "Add append-only action ledger with fold-by-id reads and rotation"`. Update `CHANGELOG.md` Unreleased/Added. Merge, push.

---

### Task 3: Principals and permissions

**Branch:** `principals-permissions`

**Files:**
- Create: `src/permissions.ts`, `src/permissions.test.ts`
- Modify: `src/services.ts`, `src/gateway.ts` (principal resolution + routes), `src/types.ts` (`IncomingMessage.principal?: string`), `src/channels/discord.ts`, `src/channels/telegram.ts` (pass stable identity in `sender`)

**Interfaces:**

```ts
export type Role = 'owner'|'adult'|'child'|'guest';
export type Connector = 'family'|'network'|'grocery'|'desktop'|'email'|'calendar'|'memory'|'goals'|'monitors';
export type Level = 'read'|'act';
export interface Binding { channel: string; identity: string }
export interface Principal { id: string; name: string; role: Role; bindings: Binding[]; grants: Partial<Record<Connector, Level>> }
export const CONNECTORS: Connector[];
export class Principals {
  constructor(dataDir: string);                       // loads principals.json or seeds an owner from config identity if missing
  list(): Principal[];
  get(id: string): Principal | undefined;
  upsert(p: Principal): Principal;
  remove(id: string): boolean;
  bind(id: string, b: Binding): Principal;            // identity is unique across principals for a channel
  resolve(channel: string, identity: string): Principal;   // guest principal {id:`guest:${channel}:${identity}`, role:'guest', grants:{}} when unbound
  can(p: Principal, connector: Connector, level: Level): boolean;  // owner always true; act implies read
  mcpServersFor(p: Principal): string[];              // 'gombwe' always; 'gombwe-family' if family read; third-party names only for owner
}
```

Seed: on first run write `principals.json` with `{ id: 'owner', name: config.identity.name owner, role: 'owner', bindings: [], grants: {} }`. Provide `seedFromConfig(config)` that, when `config.principals` (new optional field) exists, upserts them. Add `principals?: Principal[]` to `GombweConfig`.

- [ ] **Step 1: Tests** cover: seed creates owner; bind then resolve returns the principal; unbound resolves to guest with no grants; `can` for owner true regardless; `can(adult with family:act, 'family','read')` true; `can(child with family:read, 'family','act')` false; `mcpServersFor(child)` excludes `gombwe-family` when no family grant; binding the same identity twice moves it (no duplicates); persistence across instances.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Gateway principal resolution.** Add a private `resolvePrincipal(msg: IncomingMessage): Principal` that uses `msg.channel` and identity: for `web` use the `Cf-Access-Authenticated-User-Email` header captured at WS upgrade (store per WS client; if absent use `'local'`), for discord use `msg.sender` (change discord.ts to set `sender = message.author.id` and add `senderName`), telegram `String(ctx.from?.id)`. Set `msg.principal = principal.id` before any handling. Add `senderName?: string` to `IncomingMessage`.

- [ ] **Step 4: Routes**

```
GET    /api/principals                → list
PUT    /api/principals/:id            → upsert (owner only)
DELETE /api/principals/:id            → remove (owner only)
POST   /api/principals/:id/bind       → { channel, identity } (owner only)
GET    /api/me                        → resolved principal for this request (web header)
```

Add a request-level helper `principalFromRequest(req)` using the Access header or `'local'` and a guard `requireOwner(req,res)`.

- [ ] **Step 5: Network route guard.** Wrap every mutating `/api/network/*` route with `requireGrant(req, res, 'network', 'act')` and reads with `'read'`. Write one ledger entry per mutating network route: action names `network.device.block`, `network.device.unblock`, `network.screentime.allow`, `network.screentime.block`, `network.screentime.resume`, `network.screentime.schedule`, `network.firewall.toggle`, `network.firewall.delete`, `network.adlist.add`, `network.adlist.delete`, `network.nat.add`, `network.nat.delete`, `network.dhcp.add`, `network.dhcp.delete`, `network.dhcp.static`, `network.mt.raw`, `network.strands.cut`, `network.strands.reconnect`, `network.policy.put`, `network.dns-guard`, `network.router-timer.delete`; params: the route params and body; receipt: the response payload; outcome: `ok` or `failed`.

- [ ] **Step 6: Family route ledger.** Wherever the gateway mutates `family.json` (grep `saveFamily` / `writeFamily` in gateway.ts), record `family.<area>.<verb>` with actor `dashboard` or `chat`.

- [ ] **Step 7: Tests, build, docs (README "Household members and permissions" section), CHANGELOG, merge, push.**

---

### Task 4: Approvals

**Branch:** `approvals`

**Files:**
- Create: `src/approvals.ts`, `src/approvals.test.ts`
- Modify: `src/services.ts`, `src/gateway.ts` (routes, chat commands, notifications, WS broadcast)

**Interfaces:**

```ts
export type ApprovalClass = 'pay'|'send.external'|'delete'|'network.block.adult'|'desktop.run'|'credential'|(string & {});
export type Policy = 'auto'|'confirm'|'never';
export type ApprovalStatus = 'pending'|'approved'|'denied'|'expired';
export interface ApprovalRequest {
  id: string; class: ApprovalClass; summary: string; params?: Record<string, unknown>;
  principal: string; sessionKey?: string; channel?: string;
  status: ApprovalStatus; createdAt: string; expiresAt: string; decidedAt?: string; decidedBy?: string; ledgerId: string;
}
export type RequestResult = { policy: 'auto' } | { policy: 'never'; reason: string } | { policy: 'confirm'; approval: ApprovalRequest };
export class Approvals extends EventEmitter {
  constructor(dataDir: string, ledger: Ledger, principals: Principals, opts?: { ttlMs?: number; now?: () => Date });
  policyFor(cls: ApprovalClass): Policy;
  setPolicy(cls: ApprovalClass, policy: Policy): void;      // persisted in approvals.json { policies, requests }
  policies(): Record<string, Policy>;
  request(input: { class: ApprovalClass; summary: string; params?: Record<string, unknown>; principal: string; sessionKey?: string; channel?: string; action?: string }): RequestResult;
  decide(id: string, by: Principal, decision: 'approved'|'denied'): ApprovalRequest;  // throws on unauthorised or unknown; idempotent when same decision already made
  get(id: string): ApprovalRequest | undefined;
  listPending(): ApprovalRequest[];
  wait(id: string, timeoutMs: number): Promise<ApprovalRequest>;   // resolves on decision or expiry or timeout (returns current state)
  expireDue(): number;                                     // marks expired, returns count; call from a 30s interval
}
// events: 'approval:requested' (ApprovalRequest), 'approval:decided' (ApprovalRequest)
```

Defaults: `{ pay:'confirm', 'send.external':'confirm', delete:'confirm', 'network.block.adult':'confirm', 'desktop.run':'confirm', credential:'never' }`, unknown class → `auto`. Ledger: `request` with `confirm` writes `{ actor:'system', action: input.action ?? `approval.${cls}`, outcome:'pending', approvalId }`; `decide` updates the ledger entry outcome to `ok` on approve or `denied`; expiry updates to `expired`. Authorisation: `by.role==='owner'`, or `by.role==='adult' && by.id===approval.principal` can approve; anyone with `by.id===approval.principal` or owner can deny.

- [ ] **Step 1: Tests**: default policies; auto class returns `{policy:'auto'}`; never class returns never with reason; confirm creates pending + ledger pending; owner approve flips both; child cannot approve (throws) but requester can deny; double approve idempotent; approve after deny throws; `expireDue` with injected `now` past `expiresAt` marks expired and ledger expired; `wait` resolves when `decide` is called (use a 10 ms later decide); `wait` returns pending on timeout; persistence across instances.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Gateway wiring.**
  - Routes: `GET /api/approvals` (pending), `GET /api/approvals/:id`, `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/deny` (principal from request), `GET /api/approvals/:id/wait?timeout=25000`, `GET /api/approvals/policies`, `PUT /api/approvals/policies` (owner).
  - Chat commands in `handleCommand`: `approve <id>` and `deny <id>` (also accept the first 8 chars of the id: match unique prefix among pending).
  - On `approval:requested`: send to the originating channel session (`channel.send(sessionKey, text)`) and, if requester is not owner, to the owner's default channel (config `notify.ownerChannel`, default `'web'`). Text format:

    ```
    Approval needed [<id8>]: <summary>
    Reply /approve <id8> or /deny <id8>. Expires in 30 min.
    ```
  - Broadcast WS events `approval:requested` and `approval:decided` to the dashboard.
  - `setInterval(() => approvals.expireDue(), 30_000)` with `.unref()`.

- [ ] **Step 4: Tests, build, README section "Approvals", CHANGELOG, merge, push.**

---

### Task 5: Household memory

**Branch:** `memory`

**Files:**
- Create: `src/memory.ts`, `src/memory.test.ts`
- Modify: `src/services.ts`, `src/gateway.ts` (routes, commands, context injection), `src/agent.ts` (task prompt context)

**Interfaces:**

```ts
export type MemoryKind = 'preference'|'fact'|'goal'|'instruction'|'relationship';
export type MemorySource = { channel: string; sessionKey: string; timestamp: string; quote?: string } | { reflection: string } | { manual: string };
export interface MemoryRecord { id: string; text: string; subject: string; kind: MemoryKind; source: MemorySource; createdAt: string; updatedAt: string; lastUsedAt?: string; useCount: number; forgotten: boolean }
export class Memory {
  constructor(dataDir: string);
  remember(text: string, subject: string, kind: MemoryKind, source: MemorySource): MemoryRecord;  // returns existing (updated) when normalised text+subject matches; refuses (returns existing tombstoned? no: throws MemoryTombstonedError) when tombstoned and source is reflection
  recall(query: string, opts?: { subject?: string; kind?: MemoryKind; limit?: number }): MemoryRecord[];   // bumps useCount/lastUsedAt on returned records
  forget(idOrText: string): MemoryRecord | undefined;      // marks forgotten, writes tombstone {hash, subject, source, at}
  list(opts?: { subject?: string; kind?: MemoryKind; includeForgotten?: boolean }): MemoryRecord[];
  isTombstoned(text: string, subject: string): boolean;
  contextBlock(principal: Principal, budgetChars?: number): string;   // '' when nothing; otherwise "<household-memory>\n- [instruction|tendai] ...\n</household-memory>"
}
export function normalise(text: string): string;  // lowercase, collapse whitespace, strip trailing punctuation
```

Visibility in `contextBlock`: owner sees all subjects; others see `subject === principal.id` or `subject === 'household'`. Ordering: kind order instruction, preference, relationship, fact, goal; then `updatedAt` desc. Stop adding lines when budget would be exceeded.

- [ ] **Step 1: Tests**: remember then list; dedupe updates not inserts; recall ranks the record containing more query terms first and bumps useCount; forget marks and tombstones; reflection remember of tombstoned text throws `MemoryTombstonedError`; manual remember of tombstoned text succeeds and clears the tombstone; contextBlock ordering, budget (use budget 60 and assert the second line is dropped), visibility for adult vs owner; persistence.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Gateway wiring.**
  - Routes: `GET /api/memory?subject=&kind=`, `POST /api/memory` `{text, subject, kind}` (source manual), `DELETE /api/memory/:id` (forget), `GET /api/memory/recall?q=`.
  - Commands: `/remember <text>` (subject = principal id unless text starts with `household:`), `/forget <text|id>`, `/memory`.
  - Context injection: in `handleMessage` chat path where the first message of a session gets `skillsCtx`, also prepend `memory.contextBlock(principal)`. For resumed sessions, prepend it only when the memory store's `updatedAt` high-water mark changed since that session last received it (keep `session.memoryStamp?: string` in `Session`). In task mode prepend the block to the task prompt every time.
  - `agent.runTask` unchanged; the gateway composes the prompt.

- [ ] **Step 4: Tests, build, README "Household memory", CHANGELOG, merge, push.**

---

### Task 6: Tool registry, stdio MCP server, per-session MCP config

**Branch:** `gombwe-mcp`

**Files:**
- Create: `src/gombwe-tools.ts`, `src/gombwe-tools.test.ts`, `src/mcp/gombwe.ts`, `src/mcp-config.ts`, `src/mcp-config.test.ts`
- Modify: `src/agent.ts` (accept per-call `mcpConfigs` and env), `src/gateway.ts` (tool route, session config), `src/services.ts`

**Interfaces:**

```ts
// gombwe-tools.ts
export interface ToolContext { services: Services; principal: Principal; sessionKey?: string; channel?: string; actor: LedgerActor }
export interface ToolDef { name: string; description: string; inputSchema: z.ZodObject<any>; connector?: Connector; level?: Level; handler: (args: any, ctx: ToolContext) => Promise<ToolResult> }
export type ToolResult = { ok: true; text: string; data?: unknown } | { ok: false; error: string };
export const tools: ToolDef[];
export function listToolsFor(p: Principal): ToolDef[];        // filtered by grants
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;  // validates, checks grant, runs, records ledger for act-level tools

// mcp-config.ts
export function writeSessionMcpConfig(config: GombweConfig, dataDir: string, sessionKey: string, principal: Principal, token: string, servers: string[]): string; // returns file path
```

Tools in this task: `memory_remember {text, subject?, kind}`, `memory_recall {query, subject?, kind?, limit?}`, `memory_forget {idOrText}`, `approval_request {class, summary, params?}` (returns the decision: calls `approvals.request`, and if confirm, `await approvals.wait(id, 25 min)` and returns approved/denied/expired), `ledger_record {action, target?, params?, receipt?, outcome?}` (for Claude to record third-party side effects), `ledger_recent {limit?}` (read).

stdio server `src/mcp/gombwe.ts`: reads `GOMBWE_PORT`, `GOMBWE_SESSION_TOKEN`, `GOMBWE_PRINCIPAL`, `GOMBWE_SESSION_KEY`; on start fetches `GET /api/tools` with header `Authorization: Bearer <token>` to get the tool list (name, description, JSON schema via `zod-to-json-schema` — already transitively available through the MCP SDK; if not, add `zod-to-json-schema`), registers each with the MCP SDK, and forwards calls to `POST /api/tools/:name` with the same bearer. Keep it under 120 lines.

Gateway:
- `GET /api/tools` and `POST /api/tools/:name`: authenticate by session token (`services.sessionTokens: Map<token, {principalId, sessionKey, channel}>`), build `ToolContext`, call.
- Per-session config: in `handleMessage` (chat and task paths) before calling the agent, create or reuse a token for the session, call `writeSessionMcpConfig(...)` producing `data/mcp/<sha1(sessionKey)>.json` with `mcpServers.gombwe` (command node, args `[join(__dirname,'mcp','gombwe.js')]`, env with the four vars) and `mcpServers['gombwe-family']` when allowed, and pass `[thatPath]` to the agent as the only `--mcp-config`. Add optional `mcpConfigs?: string[]` parameter to `agent.chat(...)` and `agent.runTask(...)` (task stores it). Third-party servers (from `~/.claude.json`) are still loaded by the CLI for any session; for non-owner principals pass `--strict-mcp-config` so only the session file's servers load. Verify the flag exists with `claude --help`; if it does not, document the limitation in `docs/developer.md` and skip.

- [ ] **Step 1: Tests** for `gombwe-tools`: `listToolsFor(child)` excludes memory tools when no memory grant; `callTool('memory_remember')` writes a record and a ledger entry; `callTool` with a child on an act tool returns `{ok:false}` mentioning permission; `approval_request` with class `pay` returns pending→approved when a test approves it 20 ms later. Tests for `mcp-config`: file path is deterministic per session, JSON has the env and servers, family omitted for a principal without family grant.

- [ ] **Step 2: Implement all four files, wire gateway and agent.**

- [ ] **Step 3: Manual check** (no daemon): `node dist/mcp/gombwe.js` with env pointing at a non-listening port must exit with a clear error within 3 s.

- [ ] **Step 4: Tests, build, `docs/developer.md` (create it now: sections Architecture, Running in dev with isolated data dir, Tool registry, Adding a tool, Data files), CHANGELOG, merge, push.**

---

### Task 7: Ledger hooks on existing writers

**Branch:** `ledger-hooks`

**Files:**
- Modify: `src/mcp/family.ts` (POST to gateway `/api/ledger` instead of only `logAction`; keep `logAction`), `src/skills.ts` (`executeSkillTool` gains `ledger?` parameter; gateway passes it), `src/triggers.ts`, `src/workflows.ts`, `src/scheduler.ts` (each accepts an optional `onEvent` callback that the gateway wires to `ledger.record` with actors `trigger`, `trigger`, `cron`), `src/gateway.ts`
- Add: `POST /api/ledger` accepting a `LedgerEntry` body from loopback only (check `req.ip` is `127.0.0.1` or `::1` or `::ffff:127.0.0.1`).

- [ ] **Step 1: Tests**: `triggers.test.ts` and `scheduler.test.ts` minimal: constructing with an `onEvent` spy and calling the internal fire path (export a small `_fireForTest` or make `fireTrigger` protected-accessible via a subclass in the test) records one entry. Family MCP: extract `postLedger(entry)` into `src/mcp/family-ledger.ts` and unit test it with a mocked `fetch` (global `fetch` replaced in test).

- [ ] **Step 2: Implement.** Action names: `family.meal.set`, `family.grocery.add`, `family.grocery.remove`, `family.pantry.*`, `family.recipe.*`, `family.event.*`, `skill.<name>.<tool>`, `trigger.<name>.fired`, `workflow.<name>.step`, `cron.<id>.run`.

- [ ] **Step 3: Tests, build, docs, CHANGELOG, merge, push.**

---

### Task 8: Deterministic monitors

**Branch:** `monitors`

**Files:**
- Create: `src/monitors.ts`, `src/monitors.test.ts`, `src/monitors.fixtures/` (two HTML files: `page-v1.html`, `page-v2.html`, and `page-v1-noise.html` differing only in a timestamp)
- Modify: `src/triggers.ts` (`url_change` delegates), `src/gombwe-tools.ts` (`monitor_create`, `monitor_list`, `monitor_check`), `src/gateway.ts` (routes), `src/services.ts`

**Interfaces:**

```ts
export type MonitorKind = 'url'|'file'|'email';
export interface Monitor { id: string; name: string; kind: MonitorKind; target: string; selector?: string; intervalSec: number; lastHash?: string; lastCheckedAt?: string; lastChangedAt?: string; notify: string[]; goalId?: string; principal: string; enabled: boolean; createdAt: string }
export interface CheckResult { changed: boolean; hash: string; diff?: string; error?: string }
export class Monitors extends EventEmitter {
  constructor(dataDir: string, ledger: Ledger, opts?: { fetchImpl?: typeof fetch; minDiffChars?: number; noise?: RegExp[] });
  create(m: Omit<Monitor,'id'|'createdAt'|'lastHash'|'lastCheckedAt'|'lastChangedAt'>): Monitor;
  list(filter?: { principal?: string; goalId?: string }): Monitor[];
  get(id: string): Monitor | undefined;
  remove(id: string): boolean;
  toggle(id: string, enabled: boolean): Monitor | undefined;
  check(id: string): Promise<CheckResult>;                 // persists hash; emits 'monitor:changed' {monitor, diff}; ledger entry on change
  ingestEmail(msg: { from: string; subject: string; text: string; id: string }): string[];   // returns ids of email monitors that matched (target is a case-insensitive substring query against from+subject+text)
  start(): void; stop(): void;                             // one setInterval per 15s that checks due monitors
  snapshotDir(id: string): string;                         // data/monitors/<id>
}
export function extractText(html: string, selector?: string): string;   // strips script/style/tags; selector supports '#id' and 'tag' only
export function normaliseText(text: string, noise?: RegExp[]): string;   // collapse whitespace; default noise removes ISO dates, times like 12:34, "x minutes ago", numbers followed by 'views'
export function diffSummary(a: string, b: string, max?: number): string; // first differing 200-char window from each side
```

- [ ] **Step 1: Tests** with a stub `fetchImpl` returning fixture bodies: first check sets hash and reports `changed:false`; v1→v1-noise reports no change; v1→v2 reports change once, writes snapshot files (`latest.txt`, `previous.txt`), emits event, ledger entry; a second `Monitors` instance on the same dir does not refire on v2; file monitor detects content change; `ingestEmail` matches subject substring; `extractText('#main')` returns only that element's text.

- [ ] **Step 2: Implement.** For `#id` selector use a regex to find the opening tag with `id="..."` and take text until its matching close by counting nested tags of the same name (good enough for v1; document limitation).

- [ ] **Step 3: Wire**: `triggers.checkUrlChange` becomes: find or create a monitor named `trigger:<id>` and call `check`; fire when changed. Routes: `GET/POST /api/monitors`, `DELETE /api/monitors/:id`, `POST /api/monitors/:id/toggle`, `POST /api/monitors/:id/check`, `GET /api/monitors/:id/snapshot`. Notify via `notifyFn` on change with the diff.

- [ ] **Step 4: Tests, build, README "Monitors", `docs/developer.md`, CHANGELOG, merge, push.**

---

### Task 9: Goals

**Branch:** `goals`

**Files:**
- Create: `src/goals.ts`, `src/goals.test.ts`
- Modify: `src/gombwe-tools.ts` (`goal_create`, `goal_plan`, `goal_wait`, `goal_status`, `goal_stop`), `src/gateway.ts` (routes, commands, restart resume), `src/services.ts`, `src/agent.ts` (task result callback)

**Interfaces:**

```ts
export type GoalStatus = 'planning'|'active'|'waiting'|'done'|'abandoned'|'paused';
export type StepStatus = 'pending'|'running'|'waiting'|'done'|'failed'|'skipped';
export interface GoalStep { n: number; text: string; status: StepStatus; taskId?: string; monitorId?: string; approvalId?: string; receipt?: Record<string, unknown>; output?: string; startedAt?: string; finishedAt?: string }
export interface Goal { id: string; principal: string; title: string; outcome: string; status: GoalStatus; plan: GoalStep[]; createdAt: string; updatedAt: string; log: { time: string; text: string }[]; replans: number; channel?: string; sessionKey?: string }
export interface GoalDeps {
  runStep: (goal: Goal, step: GoalStep) => Promise<{ taskId: string }>;   // starts a task; completion arrives via onTaskFinished
  monitors: Monitors; ledger: Ledger; notify: (goal: Goal, text: string) => void;
  maxSteps?: number; maxReplans?: number;
}
export class Goals extends EventEmitter {
  constructor(dataDir: string, deps: GoalDeps);
  create(input: { principal: string; title: string; outcome: string; channel?: string; sessionKey?: string }): Goal;   // status planning
  setPlan(id: string, steps: string[]): Goal;                       // status active, plan pending; throws if > maxSteps
  replan(id: string, steps: string[]): Goal;                        // increments replans; throws when > maxReplans
  tick(): Promise<void>;                                            // for each active goal with no running step, start the next pending step
  onTaskFinished(taskId: string, result: { ok: boolean; output: string }): void;  // marks step done/failed, logs, notifies, next tick
  waitFor(id: string, stepN: number, monitor: Omit<Monitor,'id'|'createdAt'|'principal'|'goalId'|'lastHash'|'lastCheckedAt'|'lastChangedAt'>): Goal;  // creates monitor, step waiting, goal waiting
  onMonitorChanged(monitorId: string, diff: string): void;          // step waiting → pending with the diff appended to text; goal active; tick
  stop(id: string): Goal | undefined;                               // abandoned; removes its monitors
  pause(id: string): Goal | undefined; resume(id: string): Goal | undefined;
  list(filter?: { principal?: string; status?: GoalStatus }): Goal[]; get(id: string): Goal | undefined;
  resumeAfterRestart(): void;                                       // running steps → pending; waiting goals keep monitors
}
```

Step prompt composed by the gateway's `runStep`: goal title, outcome, full plan with statuses, memory context block, and the instruction that if the step needs to wait on something external the model must call `goal_wait` with a monitor spec and end; if the step needs approval, the tools will ask.

- [ ] **Step 1: Tests** with a fake `runStep` that records calls and returns ids: create→setPlan→tick starts step 1 only; `onTaskFinished(ok)` marks done and starts step 2; failure marks failed and pauses the goal with a log line; `waitFor` creates a monitor with `goalId` and sets waiting; `onMonitorChanged` resumes and ticks; `stop` removes monitors; `resumeAfterRestart` re-queues; step budget throws; persistence.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Wire**: gateway `runStep` calls `agent.runTask(prompt, channel, sessionKey, workingDir, mcpConfigs)` and maps `task:completed`/`task:failed` events to `goals.onTaskFinished`. `monitors.on('monitor:changed')` → `goals.onMonitorChanged`. A 20 s interval calls `goals.tick()`. `goals.resumeAfterRestart()` at startup. Commands `/goal <text>` (creates and asks Claude in the same session to plan it via `goal_plan`), `/goals`, `/goal stop <id>`. Routes: `GET /api/goals`, `GET /api/goals/:id`, `POST /api/goals`, `POST /api/goals/:id/stop|pause|resume`.

- [ ] **Step 4: Tests, build, README "Goals", developer doc, CHANGELOG, merge, push.**

---

### Task 10: Reflection and daily suggestion

**Branch:** `reflection`

**Files:**
- Create: `src/reflection.ts`, `src/reflection.test.ts`
- Modify: `src/services.ts`, `src/gateway.ts` (register cron), `src/config.ts` (`reflection?: { enabled: boolean; hour: number; suggestions: boolean; timezone: string }` default `{enabled:true, hour:2, suggestions:true, timezone:'Australia/Melbourne'}`)

**Interfaces:**

```ts
export interface ReflectionInput { date: string; transcripts: { sessionKey: string; principal: string; entries: TranscriptEntry[] }[]; existing: MemoryRecord[]; tombstones: { text: string; subject: string }[] }
export interface ReflectionProposal { text: string; subject: string; kind: MemoryKind; quote: string }
export interface ReflectionOutput { proposals: ReflectionProposal[]; suggestion?: string }
export function buildReflectionPrompt(input: ReflectionInput): string;
export function parseReflectionOutput(text: string): ReflectionOutput;   // finds the first JSON object in the text; tolerant of code fences
export async function runReflection(deps: { sessions: SessionManager; principals: Principals; memory: Memory; ledger: Ledger; ask: (prompt: string) => Promise<string>; notify: (text: string) => void; date?: string; suggestions: boolean }): Promise<{ added: number; skipped: number; suggested: boolean }>;
```

- [ ] **Step 1: Tests**: prompt includes tombstones and instructs JSON-only output; parser handles fenced JSON; `runReflection` with a fake `ask` returning two proposals (one tombstoned) adds one, skips one, records one ledger entry `reflection.run`, and calls `notify` once when a suggestion is present and `suggestions` is true, never when false.

- [ ] **Step 2: Implement; register a cron job in the scheduler at `0 <hour> * * *` in the configured timezone that calls `runReflection` with `ask = (p) => agent.chat(p, workingDir).then(r => r.response)`.**

- [ ] **Step 3: Tests, build, docs, CHANGELOG, merge, push.**

---

### Task 11: Desktop actions

**Branch:** `desktop-actions`

**Files:**
- Create: `src/desktop.ts`, `src/desktop.test.ts`, `skills/desktop/SKILL.md`
- Modify: `src/gombwe-tools.ts` (`desktop_run`), `src/config.ts` (nothing new)

**Interfaces:**

```ts
export type DesktopClass = 'desktop.read'|'desktop.run';
export function classify(script: string, lang: 'applescript'|'shell'): DesktopClass;  // write patterns → desktop.run
export async function runDesktop(script: string, lang: 'applescript'|'shell', opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
```

Write patterns (case-insensitive): `make new`, `delete`, `send`, `save`, `set ` followed by an app object (`set (the )?(name|content|subject|due date|body) of`), `do shell script` containing `>`, `rm `, `mv `, `cp `, `mkdir`, `touch`, `defaults write`, `kill`, `launchctl`; shell: any of `rm|mv|cp|mkdir|touch|tee|>|>>|kill|launchctl|defaults write|osascript.*(make new|delete|send)`. Anything else is `desktop.read`.

Tool `desktop_run {script, lang, purpose}`: classify; if `desktop.run` call `approvals.request({class:'desktop.run', summary: purpose + first 200 chars})` and wait; on approval run with `osascript -e` or `/bin/zsh -c`; ledger entry with receipt `{code, stdoutHead, stderrHead}`.

- [ ] **Step 1: Tests**: classification table (10 cases); `runDesktop('echo hi','shell')` returns stdout `hi`; timeout kills a `sleep 5` with 200 ms timeout and returns non-zero.

- [ ] **Step 2: Implement; write `skills/desktop/SKILL.md`** documenting the sanctioned read and write patterns already used in `skills/school-calendar-sync/SKILL.md` and `skills/meal-calendar-sync/SKILL.md` (Mail search, Calendar event creation with alarm rules) and that all writes go through `desktop_run`.

- [ ] **Step 3: Tests, build, docs, CHANGELOG, merge, push.**

---

### Task 12: Gated grocery checkout and Keychain CVV

**Branch:** `grocery-approval-gate`

**Files:**
- Modify: `scripts/grocery-buy.mjs` (pay step), `scripts/grocery-lib.mjs` (add `requestApproval`, `readKeychain`), `README.md` grocery section
- Create: `scripts/grocery-approval.test.mjs`

- [ ] **Step 1: Tests** (node --test, mocked fetch): `requestApproval({summary,total})` posts to `/api/approvals/request` then polls `/wait` and resolves `approved`; resolves `denied`; `readKeychain('gombwe-grocery-cvv')` shells out to `security find-generic-password -s gombwe-grocery-cvv -w` (test with an injected exec that returns `123`).

Add a gateway route `POST /api/approvals/request` (loopback only) that scripts use, returning `RequestResult`.

- [ ] **Step 2: Implement**: in both `woolworthsCheckoutAndPay` and `colesCheckoutAndPay`, immediately before the "place order" click: `const a = await requestApproval({ class:'pay', summary:`Grocery order at ${store}: ${items.length} items, total $${cartTotal}`, params:{store, total: cartTotal, items} }); if (a.status !== 'approved') { log and return { ordered:false, denied:true } }`. CVV: `const CVV = PREFS.payment?.cvv || await readKeychain('gombwe-grocery-cvv')`, and when the prefs value is present, print a one-line warning to migrate it and document the `security add-generic-password -a gombwe -s gombwe-grocery-cvv -w <cvv>` command in README. Ledger: post `grocery.cart`, `grocery.checkout` (pending → ok/denied), `grocery.order` with receipt `{store, total, orderNumber?}` through `notifyGombwe`'s sibling `postLedger` (loopback `POST /api/ledger`).

- [ ] **Step 3: Tests, build, docs, CHANGELOG, merge, push.**

---

### Task 13: WhatsApp channel

**Branch:** `whatsapp-channel`

**Files:**
- Create: `src/channels/whatsapp.ts`, `src/channels/whatsapp.test.ts`, `docs/whatsapp-setup.md`
- Modify: `src/types.ts` (`channels.whatsapp?: { token: string; phoneNumberId: string; appSecret: string; verifyToken: string }`), `src/gateway.ts` (webhook routes, channel registration), `src/config.ts`

**Interfaces:**

```ts
export class WhatsAppChannel implements ChannelAdapter {
  name = 'whatsapp';
  constructor(cfg: { token: string; phoneNumberId: string; appSecret: string; verifyToken: string }, opts?: { fetchImpl?: typeof fetch; transcribe?: (file: string) => Promise<string | null>; mediaDir: string });
  verifySignature(rawBody: Buffer, header: string | undefined): boolean;      // X-Hub-Signature-256 = sha256=HMAC(appSecret, rawBody)
  handleVerify(query: Record<string,string>): { status: number; body: string }; // hub.mode/subscribe + hub.verify_token → hub.challenge
  async handleWebhook(payload: unknown): Promise<void>;                          // parses messages[]: text, and audio (download via /media/<id> then transcribe if available)
  async send(sessionKey: string, message: string): Promise<void>;               // sessionKey 'whatsapp:<phone>' or 'notify:whatsapp' → config notify number
  onMessage(handler: MessageHandler): void; start(): Promise<void>; stop(): Promise<void>;
}
```

`IncomingMessage` for WhatsApp: `channel:'whatsapp'`, `sessionKey:'whatsapp:<phone>'`, `sender:<phone>`, `senderName` from `contacts[0].profile.name`. Unknown (guest) numbers: the gateway's principal resolution returns guest; the WhatsApp adapter itself does not decide. The gateway, on guest from WhatsApp, replies once per number per day "This assistant is private." and records `whatsapp.guest.blocked`.

Gateway routes: `GET /api/webhook/whatsapp` (verify), `POST /api/webhook/whatsapp` (needs raw body: register `express.raw({type:'application/json'})` for this path before the JSON parser, verify signature, then `JSON.parse`).

- [ ] **Step 1: Tests**: signature verify true/false; verify handshake; webhook with a text message calls handler with the right session key and sender; audio message with `transcribe` stub delivers transcribed text, without stub delivers a `[voice note not supported]` text; `send` posts to `https://graph.facebook.com/v21.0/<phoneNumberId>/messages` with the bearer token (mocked fetch asserts URL and body).

- [ ] **Step 2: Implement; write `docs/whatsapp-setup.md`** (Meta app, permanent token, phone number id, webhook URL `https://dashboard.gombwe.com/api/webhook/whatsapp`, Cloudflare Access bypass policy for that path, config keys, binding Mag's number to her principal via `POST /api/principals/mag/bind`).

- [ ] **Step 3: Tests, build, README channels table, CHANGELOG, merge, push.**

---

### Task 14: Inbound email channel and outbound send

**Branch:** `email-channel`

**Files:**
- Create: `src/channels/email-in.ts`, `src/channels/email-in.test.ts`, `src/channels/email-in.fixtures/plain.eml`, `.../with-attachment.eml`, `docs/email-in-setup.md`
- Modify: `src/types.ts` (`channels.email?: { address: string; bucket: string; prefix?: string; region: string; pollSec?: number }`), `src/gateway.ts`, `src/gombwe-tools.ts` (`email_send {to, subject, body}` class `send.external` unless `to` is a principal binding)
- Add dependency: `mailparser`, `@aws-sdk/client-s3`

**Interfaces:**

```ts
export interface ParsedMail { id: string; from: string; to: string[]; subject: string; text: string; html?: string; date?: string; attachments: { filename: string; path: string; contentType: string; size: number }[] }
export async function parseEml(raw: Buffer, inboxDir: string, id: string): Promise<ParsedMail>;
export class EmailChannel implements ChannelAdapter {
  name = 'email';
  constructor(cfg: EmailConfig, deps: { s3: { list(prefix: string): Promise<string[]>; get(key: string): Promise<Buffer>; del(key: string): Promise<void> }; ses: { send(m: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }> }; dataDir: string; pollSec?: number });
  async pollOnce(): Promise<number>;     // processes new objects, delivers IncomingMessage per mail (text = subject + body + attachment list), deletes object after success
  async send(sessionKey: string, message: string): Promise<void>;  // 'email:<addr>' → reply to addr with subject 'Re: gombwe'
  onMessage(h: MessageHandler): void; start(): Promise<void>; stop(): Promise<void>;
}
export function makeS3Deps(region: string, bucket: string): EmailChannel['deps']['s3'];   // real SDK
export function makeSesDeps(region: string): EmailChannel['deps']['ses'];
```

- [ ] **Step 1: Tests**: parse plain fixture (from, subject, text); parse attachment fixture writes the file under `inbox/<id>/` and lists it; `pollOnce` with fake s3 delivers two messages with `sessionKey: 'email:<from>'` and deletes both keys; a failing handler leaves the key; `send` calls `ses.send` with the configured from address.

- [ ] **Step 2: Implement; wire** into gateway channels when `config.channels.email` is set; `monitors.ingestEmail` is called for every delivered mail. Write `docs/email-in-setup.md` (SES domain verification for gombwe.com in ap-southeast-2, MX record in Cloudflare `10 inbound-smtp.ap-southeast-2.amazonaws.com`, receipt rule set → S3 bucket with prefix `inbox/`, IAM permissions for the existing profile, config keys).

- [ ] **Step 3: Tests, build, README, CHANGELOG, merge, push.**

---

### Task 15: Remote MCP endpoint

**Branch:** `remote-mcp`

**Files:**
- Create: `src/remote-mcp.ts`, `src/remote-mcp.test.ts`, `docs/remote-mcp-setup.md`
- Modify: `src/gateway.ts` (mount), `src/types.ts` (`remoteMcp?: { enabled: boolean; accessTeamDomain: string; accessAud: string; allowLocalUnauthenticated?: boolean }`), `src/gombwe-tools.ts` (add `family_*` proxies: `family_lists`, `family_grocery_add`, `family_grocery_remove`, `family_meals_week`, `family_meal_set`, `family_events`, `family_event_add`; `network_devices`, `network_device_block`, `network_device_unblock`, `network_screentime_set`; `grocery_order` (class `pay`))
- Add dependency: `jose`

**Interfaces:**

```ts
export function createRemoteMcpHandler(services: Services, cfg: RemoteMcpConfig, opts?: { jwks?: (url: string) => ReturnType<typeof createRemoteJWKSet> }): (req: Request, res: Response) => Promise<void>;
export async function principalFromAccessJwt(token: string, cfg: RemoteMcpConfig, principals: Principals, verify: (t: string) => Promise<{ email?: string; common_name?: string }>): Promise<Principal>;   // service tokens map by common_name binding on channel 'access-service'
```

Implementation: use the MCP SDK's `StreamableHTTPServerTransport` (stateless mode: new transport per request) with a `McpServer` whose tools are `listToolsFor(principal)`; requests without a valid `Cf-Access-Jwt-Assertion` get 401 unless `allowLocalUnauthenticated` and `req.ip` is loopback (dev only). Every call ledgered with actor `remote`.

- [ ] **Step 1: Tests**: 401 without header; loopback allowed in dev flag; a valid fake JWT (inject `verify`) with a bound email resolves that principal; `tools/list` over HTTP for a child omits network tools; `tools/call memory_recall` returns text. Use the SDK's `Client` with `StreamableHTTPClientTransport` against an ephemeral Express server in the test.

- [ ] **Step 2: Implement; mount at `POST|GET|DELETE /mcp`.** Write `docs/remote-mcp-setup.md`: tunnel ingress `mcp.gombwe.com → http://localhost:<port>/mcp`, Access application with emails, service token creation, adding the connector in the Claude app (Settings → Connectors → Add custom connector, URL `https://mcp.gombwe.com/mcp`), and in Claude Code (`claude mcp add --transport http gombwe https://mcp.gombwe.com/mcp --header "CF-Access-Client-Id: ..." --header "CF-Access-Client-Secret: ..."`).

- [ ] **Step 3: Tests, build, README "Use gombwe from the Claude app", CHANGELOG, merge, push.**

---

### Task 16: Dashboard design system and shell

**Branch:** `dashboard-shell`

**Files:**
- Modify: `ui/style.css` (replace `:root` palette and shell), `ui/index.html` (nav, Home tab, fonts), `ui/app.js` (tab registry, Home data)
- Create: `ui/theme.css` (tokens only), `docs/design-system.md`

Direction (from the owner): the current warm cream and terracotta shell reads as fake. Replace with the clean Family palette across the whole app: white surfaces, near-black text, one muted blue accent, hairline `#E4E6EB` borders, 6 and 8 px radii, system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`), `ui-monospace` for numbers and ids, no Google Fonts, no shadows heavier than `0 1px 2px rgba(0,0,0,.04)`, motion 120 ms or none. Dark mode via `prefers-color-scheme` with tokens redefined. Dense: 13 px base, 8 px spacing grid, tables over cards where data is tabular.

Tokens (`ui/theme.css`):

```css
:root {
  --bg:#FFFFFF; --bg-soft:#FAFAFB; --surface:#FFFFFF; --border:#E4E6EB; --border-soft:#EFF0F3;
  --text:#1A1D24; --text-2:#4B5260; --text-3:#8A92A0; --accent:#2563EB; --accent-soft:rgba(37,99,235,.08);
  --ok:#15803D; --ok-soft:rgba(21,128,61,.08); --warn:#B45309; --warn-soft:rgba(180,83,9,.08); --danger:#B91C1C; --danger-soft:rgba(185,28,28,.08);
  --topbar:#FFFFFF; --sidebar:#FAFAFB; --sidebar-w:220px;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif; --mono:ui-monospace,"SF Mono",Menlo,monospace;
  --r:6px; --r-lg:8px; --shadow:0 1px 2px rgba(0,0,0,.04); --t:120ms ease;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#0F1115; --bg-soft:#151821; --surface:#151821; --border:#262A35; --border-soft:#1E222B;
  --text:#E6E8EE; --text-2:#A6ADBB; --text-3:#6B7280; --accent:#5B8DEF; --accent-soft:rgba(91,141,239,.14);
  --topbar:#0F1115; --sidebar:#12151C; --shadow:none; } }
:root[data-theme="dark"] { /* same values as above */ }
```

Map the old variable names (`--bg-deep`, `--surface-alt`, `--border-light`, `--text-4`, `--accent-hover`, `--accent-bg`, `--green`, `--green-bg`, `--red`, `--red-bg`, `--amber`, `--amber-bg`, `--topbar-text`, `--topbar-text2`, `--sidebar-bg`, `--serif`, `--radius`, `--radius-lg`, `--shadow-md`, `--shadow-lg`, `--transition`) to the new tokens in `theme.css` so the existing 2,800 lines keep working, then remove serif usage (`--serif: var(--sans)`).

- [ ] **Step 1**: Create `theme.css`, link it before `style.css`, delete the `:root` block and Google Fonts link from `style.css`/`index.html`. Load the page from `dist` with the dev server on a temp data dir and random port (`GOMBWE_DATA_DIR=<tmp> node dist/index.js start --port 18999` if the CLI supports it; check `src/index.ts` for the flag; else set `port` in a temp config via `GOMBWE_CONFIG_DIR` env, adding that env support to `config.ts` if missing (small, tested change)). Screenshot with the puppeteer MCP or `scripts/chrome-setup.mjs` style CDP at 390 px and 1280 px widths, save under the scratchpad, and inspect.

- [ ] **Step 2: Shell**: white topbar with hairline bottom border, brand in 600 weight, status dot, search; sidebar groups: Household (Home, Chat, Family, Goals), Home network (Network), Agent (Activity, Memory, Monitors, Permissions), System (Jobs, Skills, Services). Active item: accent-soft background, accent text. Tabs render only when `/api/me` grants allow (mapping: Family→family read, Network→network read, Goals→goals read, Memory→memory read, Monitors→monitors read, Permissions→owner, Activity→any adult or owner, Jobs/Skills/Services→owner).

- [ ] **Step 3: Home tab** `#tab-home`: three columns on desktop, stacked on phone: Today (today's family events and meals from `/api/family`), Needs you (pending approvals from `/api/approvals` with Approve and Deny), Active goals (from `/api/goals?status=active`), plus a compact Alerts strip from `/api/network/alerts`. Sections are plain tables and lists, headed in 11 px uppercase `--text-3` labels.

- [ ] **Step 4: Sweep** every existing tab for hard-coded warm colours (`grep -n "#C47B4B\|#F6F3EE\|Newsreader\|serif" ui/*.css ui/*.html ui/*.js`) and replace with tokens. Family page keeps its scoped vars but they now alias the global ones.

- [ ] **Step 5: Screenshots at both widths, light and dark**, fix what looks off, commit `Dashboard: instrument-panel design system, Home tab, grant-aware navigation`, write `docs/design-system.md` (tokens, type scale, spacing, component rules, do and don't), CHANGELOG, merge, push.

---

### Task 17: Dashboard Activity tab and approvals in chat

**Branch:** `dashboard-activity`

**Files:**
- Modify: `ui/index.html`, `ui/app.js`, `ui/style.css`

- [ ] **Step 1: Activity tab**: toolbar (actor select, outcome select, action prefix search, time range: 1h/24h/7d/all), pending approvals pinned at top as rows with summary, requester, age, Approve/Deny buttons; ledger table columns: time (relative, title = ISO), actor, principal, action, target, outcome chip (ok green, failed/denied red, pending amber, expired grey), receipt (truncated JSON, click to expand row). Live updates from WS events `approval:requested`, `approval:decided`, and a new `ledger:record` event the gateway broadcasts on every record.

- [ ] **Step 2: Chat**: when `approval:requested` arrives for the current session, render an inline card in the thread with the summary and Approve/Deny; on decision, the card collapses to one line. When a `ledger:record` arrives with the current `sessionKey`, append a small "acted: <action>" chip under the last assistant message linking to Activity filtered by that id.

- [ ] **Step 3: Screenshot both widths, commit, CHANGELOG, merge, push.**

---

### Task 18: Dashboard Memory, Goals, Monitors, Permissions tabs

**Branch:** `dashboard-agent-tabs`

**Files:**
- Modify: `ui/index.html`, `ui/app.js`, `ui/style.css`

- [ ] **Step 1: Memory**: grouped by subject then kind; each row text, source (chip: said on discord 3 Sep / inferred 27 Sep / manual), Forget button; add form (text, subject select from principals + household, kind select). Inferred rows have a dotted left border.

- [ ] **Step 2: Goals**: list with status chip, title, principal, updated; detail pane with outcome, plan steps (n, text, status chip, receipt, output toggle), log, Stop/Pause/Resume.

- [ ] **Step 3: Monitors**: table (name, kind, target, interval, last checked, last changed, enabled toggle, Check now); detail shows latest/previous snapshot side by side with the diff summary.

- [ ] **Step 4: Permissions**: principals table (name, role, bindings as chips with remove, add binding form); grants grid (rows principals, columns connectors, cell select none/read/act); approval policy table (class, policy select). All owner-only, PUT on change with a saved toast.

- [ ] **Step 5: Screenshots, commit, CHANGELOG, merge, push.**

---

### Task 19: Smoke script and README

**Branch:** `smoke-and-readme`

**Files:**
- Create: `scripts/muse-smoke.mjs`
- Modify: `README.md` (rewrite the top: what gombwe is now, in the household-agent framing; sections for each capability linking to docs), `package.json` (`"smoke": "node scripts/muse-smoke.mjs"`, version `0.3.0`)

- [ ] **Step 1**: Script starts the gateway in a child process with `GOMBWE_CONFIG_DIR=<tmp>` and a random free port, waits for `/api/status`, then: `POST /api/memory` → `GET /api/memory/recall?q=` finds it; `POST /api/approvals/request` (pay) → pending → `POST /approve` → `GET` shows approved and ledger shows ok; `POST /api/goals` → `POST /api/goals/:id/plan` (add this route in the script's task if missing) → create a file monitor via `POST /api/monitors` with `goalId` → touch the file → `POST /api/monitors/:id/check` → goal status active; `POST /mcp` (dev loopback) `tools/list` returns the tool names; print PASS/FAIL per step and exit non-zero on any failure. Kill the child on exit. It must never read `~/.claude-gombwe`.

- [ ] **Step 2: Run it, fix anything it finds, commit, merge, push.**

---

### Task 20: Architecture decision records

**Branch:** `adrs`

**Files:** `docs/adr/README.md` and:

1. `0001-household-agent-not-personal-assistant.md` (connector-first; Claude app is the personal client)
2. `0002-claude-max-cli-only-inference.md`
3. `0003-ledger-is-the-source-of-truth-for-side-effects.md`
4. `0004-approval-classes-not-allowlists.md`
5. `0005-principals-bound-by-channel-identity.md`
6. `0006-single-tool-registry-three-transports.md`
7. `0007-gateway-single-writer-of-stores.md`
8. `0008-deterministic-monitors-over-prompt-polling.md`
9. `0009-household-memory-separate-from-owner-memory.md`
10. `0010-whatsapp-cloud-api-and-ses-inbound.md`
11. `0011-remote-mcp-behind-cloudflare-access.md`
12. `0012-dashboard-instrument-panel-design-system.md`
13. `0013-no-vm-isolation-of-the-claude-cli.md` (accepted risk)

Format: Title, Status (accepted, date), Context, Decision, Consequences, Alternatives considered. 150 to 300 words each, argued from the spec. Commit, merge, push.

---

### Task 21: Documentation set, roadmap, releases

**Branch:** `docs-and-roadmap`

**Files:**
- Create: `docs/user-guide.md`, `docs/magret.md`, `docs/investor.md`, `docs/roadmap.md`, `docs/releases.md`
- Modify: `docs/developer.md`, `README.md`, `CHANGELOG.md`

- [ ] **`docs/user-guide.md`**: for the owner. Setting up members and bindings, granting, what needs approval and how to approve from each channel, memory commands, goals, monitors, using gombwe from the Claude app, inbound email address, WhatsApp, what is logged.

- [ ] **`docs/magret.md`**: for Magret, in plain warm language, no jargon, phone-first. What gombwe is for the family, how to message it on WhatsApp, examples she can send today (add to grocery list, what is for dinner, when is the school thing, remind Tendai), what she will be asked to approve and why, how to tell it to forget something, where to see the family calendar and meals on her phone, what it will never do without a person saying yes.

- [ ] **`docs/investor.md`**: honest memo, no invented metrics. Problem (household admin load; assistants are personal, not household; home control is fragmented), product (household agent on a home host; connector to the assistants people already use), what exists today (list, with the spec and ledger as proof), moat (household data, LAN presence, approvals and audit, grocery dataset), business models considered (hosted Mac mini signup, per-household subscription, grocery data), risks (Claude dependency, Apple/Meta bundling, support load), what is being validated next and with whom (the household, then friends via the hosted signup), the ask left as a placeholder sentence the owner fills in.

- [ ] **`docs/roadmap.md`** and **`docs/releases.md`**: releases as tags cut on `main` at the end of this build: `v0.3.0` ledger, principals, approvals, memory (Tasks 2 to 7); `v0.4.0` monitors, goals, reflection, desktop, grocery gate (8 to 12); `v0.5.0` WhatsApp, email, remote MCP (13 to 15); `v1.0.0` dashboard, smoke, docs (16 to 21). Roadmap after v1.0: semantic recall via Haiku, container-per-household hosting, landing page hosted signup, warm standby on the Pro, address-list refactor on the router, firewall rule cleanup, Hagezi tiers, per-tab polish. Mark the earlier "deprioritised" items with their status.

- [ ] **Tag releases**: after each release group's tasks are merged, `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`, and move CHANGELOG Unreleased into the version heading.

- [ ] Commit, merge, push.

---

## Self-review

Spec coverage: s4 Task 5 and 10; s5 Tasks 2 and 7; s6 Tasks 3, 4, 6; s7 Task 8; s8 Task 12; s9 Task 11; s10 Task 9; s11.1 Task 13; s11.2 Task 14; s11.3 Task 3 (bindings, commands in Task 4); s12 Tasks 6, 12, 15; s13 none needed; s14 Tasks 16 to 18; s15 Tasks 1 and 19; s17 Task 15; s18 covered by the above; s19 file list matches; ADRs and docs Tasks 20 and 21.

Type consistency: `Principal`, `Ledger`, `Approvals.request` result, `Monitor` shape and `Goals.waitFor` signature are used identically across Tasks 3, 4, 6, 8, 9, 12, 15. `Services` gains one field per task in this order: ledger, principals, approvals, memory, sessionTokens, monitors, goals, reflection, desktop, whatsapp, email, remoteMcp.

Placeholders: none. The investor memo's "ask" sentence is intentionally left for the owner and is labelled as such in the doc.

---

### Task 22: Config directory override everywhere (added 2026-09-27 during execution)

**Branch:** `config-dir-everywhere`

**Why:** `GOMBWE_CONFIG_DIR` (Task 2) only redirects `src/config.ts`. Sixteen `src/` modules and twenty scripts still hardcode `join(homedir(), '.claude-gombwe')`, so any dev instance or smoke run touches production data on the Mac mini (which is the production host, running from a symlink to this checkout).

**Files:**
- Modify: every file listed by `grep -ln "homedir()" src/*.ts src/*/*.ts scripts/*.mjs | grep -v test`, EXCEPT `src/gateway.ts` (handled in Task 5 to avoid a merge conflict with the approvals branch) and `src/config.ts` (already done).
- Create: `src/paths.ts` exporting `configDir()`, `dataDir()`, and `scripts/paths.mjs` exporting the same for ESM scripts. Both: `process.env.GOMBWE_CONFIG_DIR || join(homedir(), '.claude-gombwe')`; `dataDir()` = `join(configDir(), 'data')`.
- Test: `src/paths.test.ts` (env set → both functions under the env dir; env unset → under home).

**Steps:** replace each hardcoded path with the helper (keep any sub-path such as `mikrotik.json` or `data/family.json` exactly as before). Scripts import `./paths.mjs`. `src/mcp/family.ts` already honours `GOMBWE_DATA_DIR`; make it fall back to `dataDir()` instead of the hardcoded home path. Grep must return zero non-test matches for `homedir()` outside `src/paths.ts`, `scripts/paths.mjs`, `src/config.ts`, and `scripts/platform.mjs` if it has an unrelated use. Build, test, commit.
