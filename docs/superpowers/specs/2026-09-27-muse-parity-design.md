# Gombwe as the household agent: Muse and Apple parity design

Date: 2026-09-27. Branch: `muse-build`. Status: approved by owner 2026-09-27 01:10 AEST.

## 0. Shape decision

Gombwe is not a second Claude app. The Claude app and Claude Code already give the owner personal memory, Gmail, Calendar and Drive connectors, scheduled cloud routines, browsing on the owner's behalf through Claude in Chrome, voice, and remote control from a phone. Rebuilding those inside gombwe would produce a worse copy.

Gombwe is the household agent and home host: the thing a cloud assistant cannot be.

- **Household, not personal.** Several people (owner, partner, children, guests) with their own identities, grants and channels. Approvals flow to the owner for actions others request.
- **On the LAN.** Router, screen time, TV, DNS and NetFlow observability, the grocery dataset and checkout scripts, Mac Mail and Calendar automation.
- **Always on with the household's data.** Goals that keep working after the app is closed, monitors that wait for the world to change, an audit trail of everything that touched the home.

Gombwe therefore exposes its tools as a remote MCP server through the existing Cloudflare tunnel, so the Claude app on a phone, Claude Code, and cloud routines call gombwe directly. The Claude app is the owner's mobile and voice client. The dashboard is the household's shared control panel, and WhatsApp is the partner's channel.

This design combines the Meta Muse (8 Sept 2026) and Apple (9 Sept 2026) announcements into one build. Section 18 lists the Apple rows and how each is satisfied or closed. The Sept 11 Apple packet's launcher script and doc set are retired by this spec.

Constraints:

- Inference stays on the Claude Code CLI under the owner's Claude Max subscription. No provider abstraction, no paid inference or media APIs.
- Free tiers and owned infrastructure only for new integrations (WhatsApp Cloud API free tier, AWS SES on the existing account, Cloudflare Tunnel and Access already in place).
- Nothing is claimed to work until tested. Simulated capabilities are not shipped; gaps are listed in section 16.
- The MacBook Pro is a development machine only. Development and tests use an isolated data directory and port and never take router ownership (only `start --headless` on the mini sets `routerOwner`).

## 1. Purpose

Deliver the household-agent capabilities that Muse and Apple announced, on gombwe, in one build: memory, audit, approvals, permissions, deterministic monitors, goals, gated actions, WhatsApp and inbound email channels, a remote MCP endpoint, and a dashboard that feels finished.

## 2. Capability map

| Announced capability | Gombwe today | This build |
|---|---|---|
| Acts: email, forms, bookings, cancellations, checkout | grocery-buy script, skills with shell | Gated host actions: grocery checkout (s8), desktop actions (s9), email-out (s11.2). Ad hoc browsing is the Claude app's job |
| Remembers what you said once; forget on request | JSONL transcripts | Household memory + reflection (s4) |
| Proactive: suggestions, goal plans, keeps working, resumes when something changes | One-shot tasks, cron, prompt-only triggers | Goals (s10), monitors (s7), daily suggestion (s4.5) |
| Asks approval before sensitive actions | None | Approval gates (s6) |
| Complete audit trail | Family action log, network policy JSONL | Action ledger (s5) |
| Per-connector permissions, read vs act, revocable | None | Principals, connectors, grants (s6) |
| Secure VM, Sentinel, credentials never visible to the agent | Claude runs with permission checks skipped on the host | Sanctioned-tool boundary, Keychain secrets, per-session MCP config (s12). Not VM isolation |
| iOS, Android, web, WhatsApp | Web via Cloudflare Access, Discord, Telegram | Claude app via remote MCP (s17), WhatsApp (s11.1). No native gombwe apps |
| Own email address | None | gombwe@gombwe.com via SES (s11.2) |
| Mac app operates desktop applications | Possible via shell, unrecorded | Desktop action class, gated and audited (s9) |
| Name, avatar, voice | identity config | Household name stays; voice is the Claude app; visual avatar is a gap |
| Apple: camera notice to calendar events | school-calendar-sync skill (mail only) | Image input via Claude app and email-in attachments into the school goal (s18) |
| Apple: Safari Notify Me | prompt-only url_change | Monitors (s7) |
| Apple: Shortcuts-style automation from a description | triggers, workflows | Goals and monitors compiled from chat (s10) |

## 3. Architecture

Everything runs inside the existing TypeScript gateway process on the Mac mini. New subsystems are modules under `src/`, each owning one JSON or JSONL file under the data directory, exposed to Claude through one new MCP server, to the Claude app through a remote MCP endpoint, and to people through gateway routes and dashboard tabs.

```
channels (web, discord, telegram, whatsapp, email-in)      Claude app / Claude Code / routines
        │  IncomingMessage + principal                             │ remote MCP (HTTPS via tunnel)
        ▼                                                          ▼
gateway.handleMessage ──► permissions.check ──► agent.chat / agent.runTask / goals
        │                                             │
        │                              Claude CLI spawn with per-session --mcp-config
        │                                             │
        │                     ┌───────────────────────┴──────────────────────┐
        │                     ▼                                              ▼
        │             mcp/family (existing)                          mcp/gombwe (new)
        │                                                     memory · ledger · approvals ·
        │                                                     goals · monitors · desktop · network
        ▼
memory.ts  ledger.ts  approvals.ts  permissions.ts  goals.ts  monitors.ts  remote-mcp.ts
        │
        ▼
data/memory.json  data/ledger.jsonl  data/approvals.json  data/principals.json
data/goals.json   data/monitors/     data/tombstones.json  data/inbox/
```

`src/mcp/gombwe.ts` follows the family server's pattern: stdio transport, spawned by the Claude CLI, reads and writes the data directory directly, and calls the gateway over loopback only where it must block on a human (approvals). The gateway writes its MCP config file at startup the same way it writes the family one today, and additionally per session so the tool set matches the principal's grants.

The remote MCP endpoint (s17) serves the same tool set over Streamable HTTP with the principal taken from the Cloudflare Access identity.

Build order is dependency order, not a sign-off sequence: stores and types → MCP server → gates and permissions on existing writers → channels → agent loops (goals, monitors, reflection) → remote MCP → dashboard.

## 4. Household memory and reflection

### 4.1 Data

`data/memory.json`, an array of records:

```
{ id, text, subject, kind, source, createdAt, updatedAt, lastUsedAt, useCount, forgotten }
subject: principal id ("tendai", "mag", "liam", "household") or free text
kind:    preference | fact | goal | instruction | relationship
source:  { channel, sessionKey, timestamp, quote } | { reflection: date } | { manual: principal }
```

`data/tombstones.json` holds the normalised text hash and source of every forgotten record so reflection cannot re-learn it from the same transcript.

Household memory is distinct from the owner's Claude app memory. It exists because tasks running on the mini and the partner's sessions cannot see the owner's Claude app memory. Owner-only personal preferences are not duplicated here.

### 4.2 Operations (`src/memory.ts`)

- `remember(text, subject, kind, source)`: dedupe by normalised text plus subject; update rather than insert when matched.
- `recall(query, {subject, kind, limit})`: keyword scoring on text and subject, boosted by recency and use count. Semantic recall through Haiku is a later swap behind the same signature.
- `forget(id | text)`: sets `forgotten`, writes a tombstone.
- `contextBlock(principal, budgetChars)`: the "what I know" block injected into every new chat session and every task prompt. Ordered by kind (instruction, preference, relationship, fact, goal), then recency. Hard cap 2,000 characters. Records about other principals are included only for `household` subjects and for the owner.

### 4.3 Claude-facing tools

`memory_remember`, `memory_recall`, `memory_forget` in `mcp/gombwe`. The context block tells Claude when to call each.

### 4.4 Chat commands

`/remember <text>`, `/forget <text or id>`, `/memory`. Every channel.

### 4.5 Reflection

Built-in cron at 02:00 Australia/Melbourne reads the previous day's transcripts, sends them to Claude with the current memory and tombstones, and receives a JSON list of proposed records. Proposals are written with `source.reflection` and flagged as inferred on the Memory tab. The same job may emit at most one proactive suggestion per day to the owner's default channel, unless suggestions are off in config.

### 4.6 Tests

Round trip in a temp data dir; dedupe; forget writes tombstone; reflection ingest rejects tombstoned text; context block respects cap, ordering and subject visibility.

## 5. Action ledger

### 5.1 Data

`data/ledger.jsonl`, append-only:

```
{ id, time, actor, principal, action, target, params, outcome, approvalId, receipt, sessionKey, taskId, goalId }
actor:   chat | task | cron | trigger | goal | monitor | dashboard | skill | script | remote
action:  dotted class, e.g. family.grocery.remove, network.device.block, grocery.checkout, email.send, desktop.run, calendar.write
outcome: ok | failed | denied | pending | expired
receipt: durable identifiers the action produced (calendar event id, router rule id, order number and total, message id)
```

Rotate at 50 MB into dated files; the dashboard reads the current and previous file.

### 5.2 Writers

`src/ledger.ts` exposes `record(entry)` and `list(filter)`. Every side-effecting path moves onto it: family MCP `logAction` (the in-file `actions` array stays for the Family tab), network block, unblock, screen-time, firewall and adlist routes, grocery buy (cart, checkout, confirmation with total), skill tool execution, trigger and workflow actions, cron runs, goal steps, monitor fires, every state-changing `mcp/gombwe` tool, every remote MCP call.

### 5.3 Reads

`GET /api/ledger?actor=&action=&outcome=&since=&limit=` and the Activity tab.

## 6. Principals, permissions and approvals

### 6.1 Principals

`data/principals.json`:

```
{ id, name, role: owner | adult | child | guest, bindings: [{channel, identity}], grants: {connector: read | act} }
```

Bindings map a channel identity to a person: Discord user id, Telegram chat id, WhatsApp phone number, Cloudflare Access email (web and remote MCP), sender address for email-in. Unbound identities are `guest`: they may chat and hold no grants. This closes the audit finding that every channel message is treated as the owner.

### 6.2 Connectors and grants

Connectors: `family`, `network`, `grocery`, `desktop`, `email`, `calendar`, `memory`, `goals`, `monitors`. Levels `read` and `act`. Defaults: owner holds everything; others hold nothing until set on the Permissions tab. A seed file gives the partner family act, grocery act, memory act, network read.

Enforcement:

- Gateway routes resolve the principal from the Access header or session binding and check the grant.
- `mcp/gombwe` tools receive the principal through the per-session MCP config environment and refuse ungranted calls with a message Claude can relay.
- The per-session MCP config lists only servers the principal may use. A child's session never has network or desktop tools, nor the third-party Gmail or Puppeteer servers.
- The remote MCP endpoint applies the same table per authenticated identity.

### 6.3 Approval classes

`src/approvals.ts` holds a policy table of action classes to `auto | confirm | never`:

| Class | Default | Examples |
|---|---|---|
| `pay` | confirm | grocery checkout, any payment |
| `send.external` | confirm | email or message to anyone outside the household |
| `delete` | confirm | removing calendar events, bulk list removal, memory wipes |
| `network.block.adult` | confirm | blocking or scheduling a device owned by an adult |
| `desktop.run` | confirm | AppleScript or shell that changes state outside gombwe's data |
| `credential` | never | the agent never enters or reads a password, card number, CVV or one-time code |
| everything else | auto | reads, household list edits, calendar proposals, memory writes |

The owner can change a class on the Permissions tab. No per-item allowlists.

### 6.4 Approval flow

1. Caller invokes `approvals.request({class, summary, params, principal, sessionKey})`.
2. A pending ledger entry and an `approvals.json` record are written. The originating channel receives summary, id, and `/approve <id>` or `/deny <id>`. The dashboard shows it at the top of Activity and inline in chat with buttons. The owner's default channel is also notified when the requester is not the owner.
3. Caller blocks (MCP tools and scripts long-poll `GET /api/approvals/:id/wait` on loopback, 25 second server timeout, re-poll) until approved, denied, or expired at 30 minutes.
4. Only an `owner`, or the requesting `adult` for their own action, can approve. Anyone bound to the session can deny.

Hard gates (the code cannot proceed without an approval id): grocery pay step, email send, network adult block, desktop run. Soft gate: the chat context instructs Claude to call `approval_request` before any external side effect through third-party MCPs an owner session may still hold. The soft gate depends on the model following the instruction; the ledger makes bypass visible, and non-owner sessions do not receive those servers.

### 6.5 Tests

State machine pending → approved, denied, expired; double approve idempotent; guest cannot approve; grant checks per connector and level; MCP config generation per principal.

## 7. Deterministic monitors

`src/monitors.ts` replaces prompt-only checks where "did it change" must be reliable.

- Monitor: `{ id, kind: url | email | file, target, selector?, interval, lastHash, lastChangedAt, notify, goalId?, enabled }`.
- URL: fetch with a stable user agent, extract `selector` text or main body, normalise whitespace and a noise regex list, hash. Fires only when the hash differs and the diff exceeds a minimum size. Last three snapshots kept under `data/monitors/<id>/`.
- Email: new message in the inbound mailbox matching a query.
- File: mtime and hash, persisted.
- On fire: ledger entry, notify, wake the owning goal.

`TriggerEngine` keeps `poll_prompt` for judgement checks; `url_change` delegates to a monitor.

Tests: two page fixtures, noise-only change does not fire, real change fires once, restart does not refire.

## 8. Gated grocery checkout

`grocery-buy.mjs` keeps its deterministic path. Its pay step calls the approvals API with the cart summary and total and refuses to place the order without an approval id. The CVV moves from `grocery-preferences.json` into the macOS Keychain (`security find-generic-password -s gombwe-grocery-cvv`), read at pay time and never returned to the model. Cart, checkout and confirmation are ledger entries.

A general web action agent on the mini is not built. Ad hoc browsing is the Claude app's job through Claude in Chrome. Recorded in section 16.

## 9. Desktop actions

`desktop_run(script, purpose)` in `mcp/gombwe` executes AppleScript or shell on the mini after an approval in class `desktop.run`, recording stdout, stderr and exit code in the ledger receipt. Read-only patterns (Mail search, Calendar read) are class `desktop.read` and auto; the tool classifies by a small pattern list (`make new`, `delete`, `send`, writes inside `do shell script`, `set` on an app object) and asks when unsure. A `desktop` skill documents the sanctioned patterns already proven in the school and meal sync skills.

## 10. Goals

`src/goals.ts`:

```
Goal { id, principal, title, outcome, status: planning | active | waiting | done | abandoned,
       plan: [{ n, text, status, taskId?, monitorId?, receipt? }], createdAt, updatedAt, nextCheck, log[] }
```

- Creation: `/goal <text>`, or Claude calling `goal_create` when a request spans several actions or time. Claude returns the plan through `goal_plan(goalId, steps)`.
- Execution: the engine runs the next runnable step as a task with the goal and memory context attached. A step may wait on a monitor (a reply email, a price change, a date); the engine attaches it and sets `waiting`. When the monitor fires the goal wakes. Steps needing approval block on the approvals flow.
- Restart safety: on start, `active` goals with a running task re-queue that step; `waiting` goals re-arm monitors. Today's behaviour of marking running tasks failed on restart with no follow-up is fixed for goal steps.
- Reporting: each step completion posts one line to the originating channel; the Goals tab shows plan, receipts and log. `/goals`, `/goal stop <id>`.
- Budget: 20 steps and 5 replans, then ask the owner.

Tests: plan persistence, sequencing, waiting and resuming, restart re-queue, budget.

## 11. Channels

### 11.1 WhatsApp

Meta WhatsApp Cloud API, free tier. `src/channels/whatsapp.ts` implements `ChannelAdapter`:

- Inbound: `POST /api/webhook/whatsapp`, signature verified with the app secret. Public path `dashboard.gombwe.com/api/webhook/whatsapp` with a Cloudflare Access bypass scoped to that path.
- Outbound: Graph API messages endpoint. Session key `whatsapp:<phone>`.
- Principal binding by phone number. Unknown numbers get one reply that the assistant is private, then silence, and a ledger entry.
- Voice notes: downloaded and transcribed if a local `whisper-cli` binary exists; otherwise the sender is told voice notes are unsupported. No paid transcription.
- `/approve` and `/deny` work here.

The earlier decision to deprioritise WhatsApp is reversed.

### 11.2 Own email address

`gombwe@gombwe.com` via AWS SES inbound in `ap-southeast-2`:

- MX for `gombwe.com` in Cloudflare points to SES inbound; a receipt rule writes raw mail to an S3 bucket.
- `src/channels/email-in.ts` polls the bucket every 60 seconds with the existing SDK, parses with `mailparser` (one new dependency), saves attachments under `data/inbox/<id>/`, and delivers an `IncomingMessage` on `email:<sender>` with the principal bound by sender address. Unknown senders are recorded and ignored.
- Replies go out through SES from the same address, class `send.external` unless the recipient is a principal.
- Gives the school-mail flow a forwarding target and gives goals a way to wait on a reply.

Owner-hands setup (DNS, receipt rule, bucket) is written to `docs/email-in-setup.md`; the code path is tested with fixture `.eml` files.

### 11.3 Existing channels

Discord and Telegram gain principal binding and the approval commands. The web channel binds the Cloudflare Access email to a principal; the sidebar shows only tabs the principal is granted, which delivers the identity-aware UI roadmap item.

## 12. Security boundary

- Sanctioned path: everything gombwe owns goes through `mcp/gombwe`, the remote MCP endpoint and gateway routes, all of which check grants, apply approval classes and write the ledger.
- Least tools per session: the per-session MCP config includes only granted servers.
- Secrets: grocery CVV, WhatsApp token and SES credentials live in the macOS Keychain or the existing AWS profile, read at use time, never placed in prompts.
- Visibility: the ledger records every side effect.
- Not provided: process or VM isolation of the Claude CLI, which still runs with permission checks skipped on the host. Owner sessions retain today's power. Recorded in section 16.

## 13. Household identity

The household gombwe keeps one name (config `identity.name`). Per-principal personas and dashboard voice are not built; the Claude app is the owner's voice interface.

## 14. Dashboard

The current warm cream and terracotta shell is replaced with one design system across every tab, extending the clean blue Family page: system font stack, hairline dividers, flat cards, dense tables, restrained motion, light and dark. It should read as an instrument panel, finished and precise.

Tabs: Home (today for this household: calendar, meals, pending approvals, active goals, alerts), Chat, Family, Network, Goals, Activity, Memory, Monitors, Permissions, Jobs, Skills, Services. Each principal sees only granted tabs. Chat renders approval requests inline with buttons and shows an "acted" chip linking to the ledger entry.

Mobile first: the partner's primary surface after WhatsApp is the dashboard on a phone.

## 15. Testing

- `node --test` with `tsx` for every store, the approval state machine, grants, monitor diffing, goals, desktop classification, email parsing, WhatsApp webhook verification, remote MCP auth, in a temp data dir.
- MCP handlers tested directly.
- Channel adapters tested with fixture webhooks and mocked fetch; nothing sends externally in tests.
- `scripts/muse-smoke.mjs` runs against an isolated data dir and port and walks: remember → recall, approval request → approve via API, goal → step waits on a file monitor → touch file → goal resumes, remote MCP tool list and one call.
- GitHub Actions runs build and tests on every push and pull request.
- Every feature branch merges only when build and tests are green.

## 16. Gaps and non-goals

- Glasses and Charm hardware, visual and video avatars.
- Stripe Link and Shop Pay checkout, retailer partnerships, the partner connector ecosystem.
- General web action agent on the mini (Claude in Chrome covers ad hoc browsing).
- VM or process isolation of the Claude CLI; Confidential VM.
- Native gombwe iOS and Android apps (the Claude app plus the web dashboard are the mobile clients).
- Paid transcription; per-principal personas; dashboard voice.
- Semantic memory recall (keyword first).
- Apple health, camera hardware, OS-privileged features: gap, per the Apple packet.

## 17. Remote MCP endpoint

`src/remote-mcp.ts` serves the `mcp/gombwe` tool set over Streamable HTTP at `POST /mcp` on the gateway, published as `mcp.gombwe.com` through the existing tunnel.

- Authentication: Cloudflare Access in front. For the Claude app, an Access application with the owner's and partner's emails; for headless callers, Access service tokens. The gateway trusts only requests carrying a valid `Cf-Access-Jwt-Assertion`, verified against the team's public keys, and maps the identity to a principal.
- Tools: the same set as the stdio server, plus `family_*` proxies so the Claude app can read and edit the household lists and calendar, `network_*` reads and gated controls, `grocery_order` behind `pay`.
- Every call is a ledger entry with actor `remote`.
- Setup for the Claude app (adding the connector) is written to `docs/remote-mcp-setup.md`.

## 18. Apple appendix

Apple packet build rows and how this spec resolves them:

| Row | Resolution |
|---|---|
| A01 durable personal context on an owned host | s4, s5, s12 |
| A02 personal context across Mail | Mail read through desktop actions (s9), email-in (s11.2); Messages remains a gap |
| A03 see what the user sees | Image input arrives through the Claude app; attachments through email-in and WhatsApp media |
| A04 recipe to grocery list | Existing family tools, now ledgered and gated |
| A06 draft email and app actions | email-out (s11.2), desktop actions (s9) |
| A08 camera notice to calendar events | The school goal accepts an image or forwarded mail and proposes events; calendar write is class `calendar.write` (auto) with alarms per the existing skill rules |
| A12 Notify Me | Monitors (s7) |
| A13 describe an automation | Goals compiled from chat (s10) |
| Native iOS and Android clients, pairing | Closed by the Claude app plus remote MCP (s17). No native gombwe apps |
| Voice, translation, recap | The Claude app; not built in gombwe |
| Health, camera hardware, OS privileges | Gap |

## 19. Files

New: `src/memory.ts`, `src/ledger.ts`, `src/approvals.ts`, `src/permissions.ts`, `src/monitors.ts`, `src/goals.ts`, `src/remote-mcp.ts`, `src/mcp/gombwe.ts`, `src/channels/whatsapp.ts`, `src/channels/email-in.ts`, `skills/desktop/SKILL.md`, `scripts/muse-smoke.mjs`, `.github/workflows/ci.yml`, tests beside each module, `docs/email-in-setup.md`, `docs/whatsapp-setup.md`, `docs/remote-mcp-setup.md`, `docs/adr/`.

Changed: `src/types.ts`, `src/gateway.ts`, `src/agent.ts`, `src/triggers.ts`, `src/mcp/family.ts`, `src/channels/discord.ts`, `src/channels/telegram.ts`, `scripts/grocery-buy.mjs`, `ui/index.html`, `ui/app.js`, `ui/style.css`, `src/config.ts`, `README.md`.

Retired: `scripts/start-personal-assistant-build.mjs` and its test, `docs/gombwe-personal-assistant-launch.md`, `docs/gombwe-mobile-expert-team-prompt.md`. The Apple matrix, inventory, transcript, audit and scope CSV are kept as reference under `docs/reference/apple-event/`.
