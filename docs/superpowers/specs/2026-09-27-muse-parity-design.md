# Gombwe Muse parity: design

Date: 2026-09-27. Branch: `muse-build`. Status: draft for owner review.

## 1. Purpose

Meta launched Muse on 8 September 2026: a personal agent that acts on the user's behalf, remembers what matters, works proactively toward goals, asks before sensitive actions, shows a full audit trail, and reaches the user on phone, web, WhatsApp and Mac. Tendai wants the whole set in gombwe, delivered as one build, not phased.

This spec maps every Muse capability onto gombwe, decides what is built, and states plainly what is a gap. It supersedes the slice-only design discussed earlier tonight. It does not supersede the Sept 11 Apple packet; where the two overlap (durable state, secure boundary, deterministic web monitoring) this spec is the implementation and the Apple packet rows are satisfied by it.

Constraints carried over unchanged from the Apple packet:

- Inference stays on the existing Claude Code CLI under the Claude Max subscription. No provider abstraction, no paid inference or media APIs.
- Free tiers and owned infrastructure only for new integrations (WhatsApp Cloud API free tier, AWS SES on the existing account, Cloudflare Tunnel already in place).
- No claim that any feature works until it is tested. Simulated capabilities are not shipped; gaps are listed in section 16.

## 2. Muse capability map

| Muse capability | Gombwe today | This build |
|---|---|---|
| Acts: email, forms, bookings, cancellations, negotiation, checkout | grocery-buy script (Coles/Woolies only), skills with shell | Web action agent (s8), desktop actions (s9), email-out via own address (s11) |
| Remembers what you said once; forget on request | JSONL transcripts, Claude `--resume` | Memory store + reflection (s4) |
| Proactive: suggestions, goal plans, keeps working after app closes, resumes when something changes | One-shot tasks, cron, prompt-only triggers | Goals engine (s10), deterministic monitors (s7), daily suggestions (s4.5) |
| Asks approval before sensitive actions | None | Approval gates (s6) |
| Complete audit trail | Family action log, network policy JSONL | Action ledger (s5) |
| Per-connector permissions, read vs act, revocable | None; every channel message is treated as owner | Principals, connectors and grants (s6) |
| Secure VM, Sentinel, credentials never visible to the agent | Claude runs with `--dangerously-skip-permissions` on the host | Sanctioned-tool boundary, Keychain secrets, per-session MCP config (s12). Not VM isolation; stated as such |
| iOS, Android, web, WhatsApp | Web dashboard via Cloudflare Access, Discord, Telegram | WhatsApp channel (s11.1). Native apps remain the Apple packet's item, not this build |
| Own email address | None | Inbound email channel on gombwe.com via SES (s11.2) |
| Mac app: operate any desktop application | Possible via shell today, untracked | Desktop action class with ledger and gates (s9) |
| Name, avatar, voice, video avatar | identity.name and personality in config | Per-principal persona (s13), browser voice in dashboard (s13). Visual avatar: gap |
| Glasses, Charm hardware, Stripe Link checkout, 1,500 partner connectors | None | Gap |

## 3. Architecture

Everything lives in the existing TypeScript gateway process on the Mac mini. New subsystems are plain modules under `src/`, each owning one JSON or JSONL file under the data directory, exposed to Claude through one new MCP server and to people through gateway routes and dashboard tabs.

```
channels (web, discord, telegram, whatsapp, email-in)
        │  IncomingMessage + principal
        ▼
gateway.handleMessage ──► permissions.check ──► agent.chat / agent.runTask / goals
        │                                             │
        │                              Claude CLI spawn with per-session --mcp-config
        │                                             │
        │                     ┌───────────────────────┴──────────────────────┐
        │                     ▼                                              ▼
        │             mcp/family (existing)                          mcp/gombwe (new)
        │                                                     memory · ledger · approvals ·
        │                                                     browser · goals · monitors
        ▼
memory.ts  ledger.ts  approvals.ts  permissions.ts  goals.ts  monitors.ts  browser-agent.ts
        │
        ▼
data/memory.json  data/ledger.jsonl  data/approvals.json  data/principals.json
data/goals.json   data/monitors/     data/tombstones.json
```

The new MCP server, `src/mcp/gombwe.ts`, follows the family server's pattern exactly: stdio transport, spawned by the Claude CLI, reads and writes the data directory directly, and calls back into the gateway over loopback HTTP only where it must block on a human (approvals). The gateway writes its MCP config file at startup the same way it writes the family one today.

Dependency order for building, which is an engineering order and not a sign-off sequence: stores and types → MCP server → gates and permissions wired into existing writers → channels → agent loops (goals, monitors, reflection) → dashboard.

## 4. Memory and reflection

### 4.1 Data

`data/memory.json`, an array of records:

```
{ id, text, subject, kind, source, createdAt, updatedAt, lastUsedAt, useCount, forgotten }
subject: principal id ("tendai", "mag", "liam", "household") or free text
kind:    preference | fact | goal | instruction | relationship
source:  { channel, sessionKey, timestamp, quote } | { reflection: date } | { manual: principal }
```

`data/tombstones.json` holds the text hash and source of every forgotten record so reflection cannot re-learn it from the same transcript.

### 4.2 Operations (`src/memory.ts`)

- `remember(text, subject, kind, source)`: dedupe by normalised text plus subject; update rather than insert when matched.
- `recall(query, {subject, kind, limit})`: keyword scoring on text and subject in v1, boosted by recency and use count. Semantic recall via Haiku is a later swap behind the same signature.
- `forget(id | text)`: sets `forgotten`, writes a tombstone.
- `contextBlock(principal, budgetChars)`: the "what I know" block injected into every new chat session and every task prompt. Ordered by kind (instruction, preference, relationship, fact, goal), then recency. Hard cap of 2,000 characters.

### 4.3 Claude-facing tools (in `mcp/gombwe`)

`memory_remember`, `memory_recall`, `memory_forget`. The context block tells Claude to call `memory_remember` when the user states a preference, a standing instruction, a fact about a person, or a goal, and to call `memory_forget` when asked to forget.

### 4.4 Chat commands

`/remember <text>`, `/forget <text or id>`, `/memory` (list for the current principal). Available on every channel.

### 4.5 Reflection

A built-in cron job at 02:00 Australia/Melbourne reads the previous day's transcripts across all sessions, sends them to Claude with the current memory list and tombstones, and receives a JSON list of proposed records. Proposals are written with `source.reflection` and appear on the Memory tab flagged as inferred. The same job may emit at most one proactive suggestion per day to the owner's default channel (a Muse behaviour: "suggests ideas unprompted"), and only if the owner has not turned suggestions off in config.

### 4.6 Tests

Memory store round trip in a temp data dir; dedupe; forget writes tombstone; reflection ingest rejects tombstoned text; context block respects the cap and ordering.

## 5. Action ledger

### 5.1 Data

`data/ledger.jsonl`, append-only:

```
{ id, time, actor, principal, action, target, params, outcome, approvalId, receipt, sessionKey, taskId, goalId }
actor:   chat | task | cron | trigger | goal | monitor | dashboard | skill | script
action:  dotted class, e.g. family.grocery.remove, network.device.block, browser.checkout, email.send, desktop.run, calendar.write
outcome: ok | failed | denied | pending | expired
receipt: free-form object with the durable identifiers the action produced (calendar event id, router rule id, order number and total, message id)
```

Retention: rotate at 50 MB into dated files; the dashboard reads the current file plus the previous one.

### 5.2 Writers

`src/ledger.ts` exposes `record(entry)` and `listRecent(filter)`. Every side-effecting path is moved onto it:

- Family MCP `logAction` becomes a ledger write (the in-file `actions` array stays for the Family tab's existing render, capped as today).
- Network block, unblock, screen-time allow/block/resume, firewall toggle, adlist changes: ledger write in the gateway route. Policy JSONL keeps writing as-is.
- Grocery buy: `notifyGombwe` already posts to the gateway; add a ledger write for cart, checkout and order confirmation with the total in the receipt.
- Skill tool execution (`executeSkillTool`), trigger and workflow actions, cron runs, goal steps, monitor fires.
- Every `mcp/gombwe` tool that changes state.

### 5.3 Reads

`GET /api/ledger?actor=&action=&outcome=&since=&limit=` and the Activity tab (s14).

## 6. Principals, permissions and approvals

### 6.1 Principals

`data/principals.json`:

```
{ id, name, role: owner | adult | child | guest, bindings: [{channel, identity}], persona?, grants: {...} }
```

Bindings map a channel identity to a person: Discord user id, Telegram chat id, WhatsApp phone number, Cloudflare Access email for the web dashboard, sender address for email-in. Unbound identities are `guest` and can chat but hold no grants. This closes the audit's finding that every channel message is treated as the owner.

### 6.2 Connectors and grants

A connector is a named capability group: `family`, `network`, `grocery`, `browser`, `desktop`, `email`, `calendar`, `memory`, `goals`, `monitors`. Each has `read` and `act` levels. Grants are per principal, e.g. Mag: family act, grocery act, memory act, network read; a child: family read. Defaults ship with the owner holding everything and everyone else holding nothing until set on the Permissions tab.

Enforcement points:

- Gateway routes check the principal from the Access header or session binding.
- `mcp/gombwe` tools receive the principal via the per-session MCP config environment and refuse ungranted calls with a clear message Claude can relay.
- The generated MCP config for a session lists only the servers the principal may use, so a child's session never has the browser or network tools at all.

### 6.3 Approval classes

`src/approvals.ts` holds a policy table of action classes to `auto | confirm | never`, seeded as:

| Class | Default | Examples |
|---|---|---|
| `pay` | confirm | grocery checkout, any browser form that submits payment |
| `send.external` | confirm | email to anyone outside the household, WhatsApp to a non-principal, web form that sends a message |
| `delete` | confirm | removing calendar events, list items in bulk, memory wipes |
| `network.block.adult` | confirm | blocking or scheduling a device owned by an adult (per household policy) |
| `desktop.run` | confirm | AppleScript or shell that changes state outside gombwe's own data |
| `browser.login` | never | the agent must not enter credentials; sessions are logged in by a person |
| everything else | auto | reads, household list edits, calendar proposals, memory writes |

Owner can change a class on the Permissions tab. There are no per-item allowlists, in line with the household's stated preference against manual curation.

### 6.4 Approval flow

1. Caller invokes `approvals.request({class, summary, params, principal, sessionKey})`.
2. A pending ledger entry and an `approvals.json` record are written. The originating channel receives: summary, the approval id, and `/approve <id>` or `/deny <id>`. The dashboard shows it at the top of Activity and in the chat thread with buttons.
3. Caller blocks (MCP tools long-poll `GET /api/approvals/:id/wait` on loopback with a 25 second server timeout and re-poll; scripts do the same) until approved, denied, or expired at 30 minutes.
4. Only a principal with `role: owner`, or the requesting adult for their own action, can approve. Anyone bound to the session can deny.

Hard gates, meaning the code path cannot proceed without an approval id: grocery pay step, browser checkout and send tools, email send, network adult block, desktop run tool. Soft gate: the chat context instructs Claude to call `approval_request` before any external side effect it performs through third-party MCPs it may still hold (Gmail, Puppeteer). The soft gate depends on the model following the instruction; the ledger makes any bypass visible after the fact, and the per-session MCP config removes those third-party servers from non-owner sessions.

### 6.5 Tests

State machine: pending → approved, denied, expired; double-approve is idempotent; a guest cannot approve; grant checks for every connector and level; MCP config generation per principal.

## 7. Deterministic monitors

Replaces prompt-only `url_change` and `poll_prompt` checks for anything where "did it change" must be reliable. `src/monitors.ts`:

- Monitor: `{ id, kind: url | email | file, target, selector?, interval, lastSnapshotHash, lastChangedAt, notify, goalId?, enabled }`.
- URL: fetch with a stable user agent, extract text of `selector` or the main body, normalise whitespace and known noise (dates, counters via regex list), hash. Change fires only when the hash differs from the persisted one and the diff is above a minimum size. Snapshots stored under `data/monitors/<id>/` with the last three kept.
- Email: new message matching a query in the inbound mailbox (s11.2).
- File: mtime and hash, same as today's file watch but persisted.
- On fire: ledger entry, notify, and wake the owning goal if any.

The existing `TriggerEngine` keeps `poll_prompt` for judgement checks; `url_change` delegates to a monitor.

Tests: fixtures of two page versions, noise-only change does not fire, real change fires once, restart does not refire.

## 8. Web action agent

Muse's "own browser": a dedicated Chrome profile the person logs into once, which the agent then drives. Gombwe already does this for groceries through `scripts/chrome-setup.mjs` and CDP in `grocery-lib.mjs`. This build generalises it.

### 8.1 Runtime (`src/browser-agent.ts`)

- One persistent Chrome profile at `~/.claude-gombwe/chrome-profile` (already present), launched on demand with remote debugging on loopback, headed on the mini so a person can log in when a login wall appears.
- Tools in `mcp/gombwe`: `browser_open(url)`, `browser_read()` returns a compact accessibility-style text of the page with numbered interactive elements, `browser_click(n)`, `browser_type(n, text)`, `browser_select(n, value)`, `browser_back()`, `browser_screenshot()`, `browser_wait(condition)`, `browser_submit(n)`.
- `browser_type` refuses fields whose name, id, autocomplete or label indicates a password, card number, CVV or one-time code (class `browser.login`, policy `never`). The person logs in by hand; the reply tells them which site is waiting.
- `browser_submit` classifies the form: if the page or form contains payment or order signals it is `pay`; if it sends a message to a third party it is `send.external`; both go through approvals with a screenshot attached to the summary. Otherwise auto.
- Per-domain allowance: a domain is usable once any principal with `browser act` has opened it through a chat request; the ledger records domain, action and principal. No allowlist file to maintain.
- Every tool call is a ledger entry with the URL and element text.

### 8.2 Use in tasks

A chat request such as "cancel my unused streaming subscription" or "book the earliest dentist slot next week" becomes a task whose prompt carries the goal, the memory context, and the browser tool instructions. Negotiation on chat widgets is the same loop: read, decide, type, with `send.external` approval before the first outbound message on a site.

### 8.3 Grocery scripts

`grocery-buy.mjs` keeps its deterministic path because it is faster and tested, but its pay step calls the approvals API and refuses to place the order without an approval id. The CVV moves from `grocery-preferences.json` into the macOS Keychain (`security find-generic-password`), read by the script at pay time only and never returned to the model.

### 8.4 Tests

Tool handlers against a local static site fixture served by the test: numbered element extraction, refusal of password fields, form classification for pay and message forms, ledger entries per call. No live retail sites in tests.

## 9. Desktop actions

Claude on the mini can already run `osascript` and shell. This build makes that a first-class, gated, audited action rather than an unrecorded side effect.

- `desktop_run(script, purpose)` tool in `mcp/gombwe`: executes AppleScript or a shell command on the mini after an approval in class `desktop.run`, records stdout, stderr and exit code in the ledger receipt.
- A `desktop` skill documents the sanctioned patterns already proven in the repo: Mail search and read, Calendar write (from the school and meal sync skills), Reminders, Notes, Finder, opening apps.
- Read-only AppleScript (Mail search, Calendar read) is class `desktop.read` and auto. The tool decides the class by a small pattern list (`make new`, `delete`, `send`, `do shell script` with a write, `set` on an app object) and otherwise asks.

## 10. Goals

Muse: "turns long-term goals into action plans", "continues working after app closure, resumes when something changes". `src/goals.ts`:

```
Goal { id, principal, title, outcome, status: planning | active | waiting | done | abandoned,
       plan: [{ n, text, status, taskId?, monitorId?, receipt? }], createdAt, updatedAt, nextCheck, log[] }
```

- Creation: `/goal <text>` or Claude calling `goal_create` when the user asks for something that will take more than one action or spans time. Claude returns a structured plan through `goal_plan(goalId, steps)`.
- Execution: the engine runs the next runnable step as a task with the goal context attached. A step may declare it is waiting on a monitor (a reply email, a price change, a date); the engine attaches the monitor and sets the goal to `waiting`. When the monitor fires the goal wakes and continues. Steps that need approval block on the approvals flow like any other action.
- Restart safety: on daemon start, goals in `active` with a running task re-queue that step; `waiting` goals re-arm their monitors. This fixes the current behaviour where running tasks are marked failed on restart with no follow-up.
- Reporting: each step completion posts a one-line update to the originating channel; the Goals tab shows plan, receipts and log. `/goals` lists them; `/goal stop <id>` abandons.
- Budget: a goal may run at most 20 steps and 5 replans before it asks the owner to continue.

Tests: plan persistence, step sequencing, waiting on a monitor and resuming, restart re-queue, step budget.

## 11. Channels

### 11.1 WhatsApp

Meta WhatsApp Cloud API, free tier (1,000 service conversations a month). `src/channels/whatsapp.ts` implements `ChannelAdapter`:

- Inbound: Meta webhook `POST /api/webhook/whatsapp` verified with the app secret signature. The public path is `dashboard.gombwe.com/api/webhook/whatsapp`, exposed through the existing tunnel with a Cloudflare Access bypass policy scoped to that path only.
- Outbound: Graph API messages endpoint. Session key `whatsapp:<phone>`.
- Principal binding by phone number. Unknown numbers get one reply explaining the assistant is private, then silence, and a ledger entry.
- Voice notes: media is downloaded and, if a local `whisper-cli` binary is present, transcribed; otherwise the user is told voice notes are not supported yet. No paid transcription.
- Approval replies (`/approve`, `/deny`) work here like everywhere.

The earlier decision to deprioritise WhatsApp is reversed by this build; Mag prefers WhatsApp and Muse ships it.

### 11.2 Own email address

`gombwe@gombwe.com` via AWS SES inbound in `ap-southeast-2`, which already hosts the agentsform SES infrastructure:

- MX for `gombwe.com` in Cloudflare points to SES inbound. A receipt rule writes raw mail to an S3 bucket.
- `src/channels/email-in.ts` polls the bucket every 60 seconds with the SDK already in the dependencies, parses the message (`mailparser`, one new dependency), saves attachments under `data/inbox/<id>/`, and delivers an `IncomingMessage` on session key `email:<sender>` with the principal bound by sender address. Unknown senders are recorded in the ledger and ignored.
- Replies go out through SES from the same address, class `send.external` unless the recipient is a principal.
- This gives the school-mail flow a forwarding target ("forward it to gombwe") and gives goals a way to wait on a reply.

Setup steps needing the owner's hands (DNS record, receipt rule, bucket) are listed in `docs/email-in-setup.md` produced by the build; the code path is tested with fixture `.eml` files.

### 11.3 Existing channels

Discord and Telegram gain principal binding and the approval commands. The web channel binds the Cloudflare Access email to a principal, which also delivers the pending "identity-aware UI" roadmap item: the sidebar shows only tabs the principal is granted.

## 12. Security boundary

What Muse calls a Secure VM and Sentinel maps to this, and no further:

- Sanctioned path: everything gombwe owns goes through `mcp/gombwe` and gateway routes, both of which check grants, apply approval classes and write the ledger.
- Least tools per session: the generated MCP config includes only granted servers; non-owner sessions never receive Gmail, Puppeteer or the Woolworths server.
- Secrets: grocery CVV, WhatsApp token and SES credentials live in the macOS Keychain or the existing AWS profile, read by gombwe code at use time and never placed in prompts. The browser tool refuses credential fields.
- Visibility: the ledger records every side effect, including third-party MCP use where Claude reports it through `approval_request`.
- Not provided: process or VM isolation of the Claude CLI, which still runs with permission checks skipped on the host. Owner sessions therefore retain the same power they have today. This is recorded in section 16 rather than papered over.

## 13. Persona and voice

- Persona: each principal may set a name and communication style for their gombwe (`persona` on the principal). It is prepended to the context block for their sessions. The owner's `identity` config remains the default.
- Voice in the dashboard: the chat composer gains a push-to-talk button using the browser's Web Speech API for recognition, and responses can be read aloud with speech synthesis, both on-device in the browser and free. Availability varies by browser; the UI shows the button only when the API exists.
- No visual or video avatar. Recorded as a gap.

## 14. Dashboard

New tabs, in the existing dense instrument-panel style, each scoped with its own CSS variables like the Family page:

- **Activity**: ledger table with actor, action, target, outcome, receipt, time; filters; pending approvals pinned at the top with Approve and Deny.
- **Memory**: records grouped by subject and kind, inferred ones flagged, Forget per row, add form.
- **Goals**: list with status, plan steps with receipts, log, Stop.
- **Permissions**: principals with bindings, connector grants grid, approval class table.
- **Monitors**: list with last change, snapshot diff view, enable toggle.

Chat threads render approval requests inline with buttons and show a small "acted" chip linking to the ledger entry when a message caused an action.

## 15. Testing

- Unit tests with the existing `node --test` and `tsx` runner for every store, the approval state machine, grant checks, monitor diffing, goal engine, browser tool classification and email parsing, all in a temp data dir.
- MCP server tests instantiate the server's tool handlers directly.
- Channel adapters tested with fixture webhooks and mocked fetch; nothing sends externally in tests.
- A `scripts/muse-smoke.mjs` runs against an isolated data dir and port and walks: remember → recall, request approval → approve via API, create goal → step waits on a file monitor → touch file → goal resumes, browser tools against the local fixture site.
- Build must pass `npm run build` and `npm test` before merge.

## 16. Gaps and non-goals

- Glasses and Charm hardware, Muse Realtime Avatar, video chat.
- Stripe Link and Shop Pay checkout, retailer catalog partnerships, the partner connector ecosystem.
- VM or process isolation of the Claude CLI; Confidential VM with user-held keys.
- Native iOS and Android apps (remain in the Apple packet; the web dashboard and WhatsApp cover mobile in this build).
- Paid transcription; voice notes depend on an optional local whisper binary.
- Semantic memory recall (keyword first; Haiku later behind the same interface).
- Negotiating bills by phone call.

## 17. Files

New: `src/memory.ts`, `src/ledger.ts`, `src/approvals.ts`, `src/permissions.ts`, `src/monitors.ts`, `src/goals.ts`, `src/browser-agent.ts`, `src/mcp/gombwe.ts`, `src/channels/whatsapp.ts`, `src/channels/email-in.ts`, `skills/desktop/SKILL.md`, `skills/web-action/SKILL.md`, `scripts/muse-smoke.mjs`, tests beside each module, `docs/email-in-setup.md`, `docs/whatsapp-setup.md`.

Changed: `src/types.ts`, `src/gateway.ts` (principal resolution, context injection, routes, MCP config generation, ledger hooks on network routes), `src/agent.ts` (per-session MCP config, memory context in task prompts), `src/triggers.ts` (delegate url_change), `src/mcp/family.ts` (ledger), `src/channels/discord.ts` and `telegram.ts` (principal binding), `scripts/grocery-buy.mjs` (approval gate, Keychain CVV), `ui/index.html`, `ui/app.js`, `ui/style.css`, `src/config.ts` (whatsapp, email-in, suggestions settings).
