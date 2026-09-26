# Developing gombwe

How the pieces fit, how to run one safely on this machine, and how to add a tool.

Read `docs/ARCHITECTURE.md` for what gombwe is. Read `docs/adr/` for why each
decision went the way it did; this file is the practical companion to those.

## Architecture

One process, `src/gateway.ts`, is the only writer of the stores and the only
thing that talks to the router (ADR 0007). It owns an Express 5 app, a WebSocket
server for the dashboard, and the channel adapters (web, Telegram, Discord).
Inference is the Claude Code CLI, spawned per call (ADR 0002) — there is no API
key anywhere.

```
channels ─┐
          ├→ gateway ──spawn──→ claude CLI ──stdio──→ mcp/gombwe.js ──HTTP──┐
dashboard ┘      │                                                          │
                 │← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ POST /api/tools/:name ─ ─ ─ ─ ─ ─ ─ ┘
                 ↓
        services: ledger · principals · approvals · memory
```

The pieces the tool surface rests on:

- **`src/ledger.ts`** — an append-only line per side effect. The source of
  truth for what happened (ADR 0003).
- **`src/permissions.ts`** — `Principals` resolves a channel identity to a
  person and answers `can(principal, connector, level)` (ADR 0005).
- **`src/approvals.ts`** — classes, not allowlists. `request()` returns auto,
  never, or a pending request to `wait()` on (ADR 0004).
- **`src/memory.ts`** — what the household is worth remembering, with a
  per-principal visibility cut (ADR 0009).
- **`src/services.ts`** — the four above plus `sessionTokens`, built once in the
  gateway constructor and passed to every tool call.

### How a session reaches its tools

1. A message arrives. The gateway resolves the sender to a `Principal`.
2. `agentOptsFor` mints (or reuses) a 32-byte session token, held in memory
   only, and writes `data/mcp/<sha1(sessionKey)>.json` naming the MCP servers
   that principal may load. The token goes in that file's `env`, mode 0600.
3. The CLI is spawned with `--mcp-config <that file>`, plus
   `--strict-mcp-config` for anyone but the owner — so nothing from
   `~/.claude.json` loads for a child's session. An owner's session also gets
   the configs from `config.agents.mcpConfigs`, because third-party servers
   declared inline in `gombwe.json` live there and the session file cannot name
   them: it only writes servers gombwe owns. The session file goes last, so it
   wins any name it shares with them.
4. The CLI spawns `dist/mcp/gombwe.js`, which fetches `GET /api/tools` with the
   token as a bearer and registers whatever comes back.
5. Each tool call becomes `POST /api/tools/:name`. The gateway re-reads the
   roster, builds a `ToolContext`, and runs the call through `callTool`.

Both tool routes require two things at once: a token this gateway minted, and a
request from a process on this machine. Loopback alone is not enough, because a
request from off the network arrives through `cloudflared` on loopback too — so
`isLocalProcessRequest` rejects anything carrying a Cloudflare header
(`cf-ray`, `cf-connecting-ip`, `cf-access-*`) or an `x-forwarded-for`.

Tokens are never persisted. A restart ends every session's tool access, which is
the right way round: a token that outlived the gateway would outlive the roster
it was checked against. A token idle for seven days is pruned on the next mint,
and writing a config sweeps `data/mcp/` of files older than the same TTL.

One more rule holds this together: a **system-originated** message — gombwe
feeding an approval decision back into a conversation — speaks for whoever last
spoke on that session, not for its `sender` of `'system'`. Without that,
`sessionPrincipalFor` would resolve the resumed turn to a guest: the child whose
request was just approved would lose their memory tools and the family server
for exactly the turn that was supposed to carry on, and their live token would be
thrown away. The session records its principal for this reason.

## Running in dev

**Never start a second gateway on this machine without an isolated config dir.**
This checkout is the production host: a launchd LaunchAgent runs `start
--headless` from `dist/`, and that instance owns the router and the stores.

`GOMBWE_CONFIG_DIR` moves everything — config, data, logs — somewhere else:

```sh
export GOMBWE_CONFIG_DIR=/tmp/gombwe-dev
mkdir -p "$GOMBWE_CONFIG_DIR"
npm run build
node dist/index.js setup            # writes $GOMBWE_CONFIG_DIR/gombwe.json
```

Then edit that `gombwe.json` before starting anything:

- **`port`** — anything but 18790, or the daemon's listener wins and you will
  spend an hour wondering why your edits do nothing.
- **`routerOwner`** — leave it off. Only the headless daemon may write router
  rules; a dev instance that thinks it owns the router will fight it over DNS
  and NetFlow targets.
- **channel tokens** — leave Telegram and Discord out. Two processes polling one
  bot token means messages land in whichever one grabbed them.

`npm run dev` (tsx watch) is fine under the same rules.

## Tool registry

`src/gombwe-tools.ts` is the one place a tool is defined (ADR 0006). A `ToolDef`
carries its name, a description the model actually reads, a zod `inputSchema`,
the `connector` grant it sits behind, and its `level`.

`callTool` does the work around the handler, so no handler has to remember to:

1. **Validate** against the zod schema. A malformed call is the model getting
   the shape wrong; it is answered and not ledgered.
2. **Check the grant** — via `Principals.can`, against the roster, not against
   the `Principal` object the caller passed in. A demotion therefore takes
   effect on the next tool call rather than the next session.
3. **Run** the handler, catching anything it throws.
4. **Write the ledger line** for an act-level tool: actor from the context,
   action `tool.<name>`, truncated params, outcome `ok`, `failed` or `denied`.
   Read-level tools leave no line.

Two tools set `selfLedgered: true` because their handler writes the entry that
matters: `approval_request` (through `approvals.request`) and `ledger_record`.
Wrapping those would record the call and lose the action.

`listToolsFor(principal)` is the grant filter; `toolManifestFor(principal)` is
the same list rendered as JSON Schema, which is what `GET /api/tools` returns.

### The three transports

The registry is transport-agnostic and tested without one. Today it is reached
in process by gateway routes, and over stdio by `src/mcp/gombwe.ts`. That bridge
is deliberately thin — around 110 lines with no logic of its own — because the
session token, the `Approvals` event emitter that `wait()` hangs off, and the
roster all live in the gateway process. It cannot check a grant itself, so it
does not try.

### Approvals inside a tool call

`approval_request` waits at most `APPROVAL_WAIT_MS` (55 s). If the household has
not decided by then, it returns `ok: true` with `status: 'pending'` and text
telling the agent to say so and end its turn. The conversation is resumed from
the gateway when the decision lands, so nothing holds a CLI process open for the
30-minute approval TTL. `approval_status` reads the state without waiting.

## Adding a tool

1. Append a `ToolDef` to `tools` in `src/gombwe-tools.ts`. Pick the `connector`
   it belongs behind and be honest about `level`: `act` is the default because a
   tool is assumed to change something unless it says otherwise.
2. Write the description for the model, not for a reference page. Say when to
   reach for it and what it will get back.
3. Add a test in `src/gombwe-tools.test.ts`. Assert the effect and the ledger
   line, and assert that someone without the grant is refused — that is the part
   that rots.
4. Nothing else. `GET /api/tools` renders the schema, the stdio bridge picks it
   up on its next start, and `listToolsFor` hides it from anyone ungranted.

If a tool reaches outside the household, it does not get a new permission
switch. It calls `approval_request` with the right class and honours the answer.

## Data files

Everything lives under `GOMBWE_CONFIG_DIR` (default `~/.claude-gombwe`):
`gombwe.json` at the top, everything else in `data/`.

| File | What |
| --- | --- |
| `ledger.jsonl` | every side effect, append-only, rotated at 50 MB |
| `principals.json` | the roster: roles, channel bindings, grants |
| `approvals.json` | pending and recent approval requests, plus the policy table |
| `memory.json`, `tombstones.json` | what is remembered, and what was forgotten |
| `mcp/<sha1>.json` | one per session: its MCP servers and bearer token, 0600, swept after 7 days |
| `tasks/tasks.json` | agent tasks and their completion-loop state |
| `family.json`, `recipes.json` | meals, grocery list, pantry |
| `network-*.json`, `dns-index.json` | router state, device policy, name cache |
| `eero-*.json`, `nextdns-config.json` | the eero sidecar and DNS filtering |
| `cron-jobs.json`, `triggers.json`, `workflows.json`, `schedules.json` | automation |

`data/mcp/` is regenerated per message, holds live credentials, and sweeps itself
of anything older than the token TTL. It is not worth backing up, and it should
not be committed.

## Testing on this machine

`npm test` runs `src/**/*.test.ts` under `node --test` with tsx. It is safe: the
tests write to `mkdtemp` directories and touch nothing real.

The rules that matter here, because this checkout is production:

- **Never start the gateway** to check something. Build and test instead. If you
  must run one, use `GOMBWE_CONFIG_DIR` and a different port, as above.
- **Never point a test at the router or the eeros.** `router-target-healer.test.ts`
  shows the pattern: inject a fake client.
- **Give every test its own temp data dir.** A test that writes to
  `~/.claude-gombwe/data` corrupts the household's real state.
- To check the MCP bridge, run it against a port nothing is listening on and
  confirm it exits with a clear message:
  ```sh
  GOMBWE_PORT=59123 GOMBWE_SESSION_TOKEN=x node dist/mcp/gombwe.js   # exits 1 in ~0.2s
  ```
