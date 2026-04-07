# claude-gombwe

An autonomous agent control panel powered by Claude Code. OpenClaw capabilities on your Claude Max subscription.

---

## The Story

OpenClaw changed what people expected from AI — not a chatbot you talk to, but a personal assistant that works for you 24/7. It monitors your email, reviews your code, checks your calendar, and messages you on WhatsApp when something needs your attention. All while you sleep.

Then Anthropic blocked subscription access. A single OpenClaw instance could burn $1,000-5,000/day in API costs — far more than the $200/month Max subscription. Overnight, 135,000+ users faced a choice: pay real API costs or lose their assistant.

**I wanted OpenClaw's capabilities but couldn't afford the API.** I had a Claude Max subscription. I had Claude Code. Could I build the same thing on top of what I was already paying for?

The answer is **gombwe**.

---

## What Claude Code Can and Can't Do

Claude Code is powerful. With MCP servers, it connects to Gmail, GitHub, Slack, and more. But it has gaps:

```
              What I needed             Claude Code alone    With Gombwe
              ─────────────             ─────────────────    ──────────
              Always-on daemon                  No              Yes
              Message from phone                No              Yes
              Auto-retry on failure             No              Yes
              Auto-continue if incomplete       No              Yes
              Verify work when done             No              Yes
              Event triggers                    No              Yes
              Multi-step workflows              No              Yes
              Concurrent tasks                  No              Yes
              Web dashboard                     No              Yes
              Native tools (no AI cost)         No              Yes
              Scheduled jobs                  Partial           Yes
              MCP servers                      Yes              Yes
              Tool use                         Yes              Yes
              Persistent conversations         Yes              Yes
```

Gombwe doesn't replace Claude Code. It sits on top and adds the orchestration layer.

---

## Architecture

```
                    ┌──────────┐   ┌──────────┐   ┌──────────┐
                    │ Discord  │   │ Telegram │   │   Web    │
                    │  Phone   │   │  Phone   │   │ Browser  │
                    └────┬─────┘   └────┬─────┘   └────┬─────┘
                         │              │              │
                         ▼              ▼              ▼
                    ┌──────────────────────────────────────────┐
                    │          Gombwe Gateway (:18790)          │
                    │                                          │
                    │  ┌─────────┐  ┌──────────┐  ┌────────┐  │
                    │  │ Channel │  │  Message  │  │  REST  │  │
                    │  │ Adapters│  │  Router   │  │  API   │  │
                    │  └────┬────┘  └────┬─────┘  └───┬────┘  │
                    │       │            │            │        │
                    │  ┌────▼────────────▼────────────▼────┐  │
                    │  │         Core Services              │  │
                    │  │  ┌──────────┐  ┌──────────┐       │  │
                    │  │  │  Agent   │  │ Session  │       │  │
                    │  │  │ Runtime  │  │ Manager  │       │  │
                    │  │  └────┬─────┘  └──────────┘       │  │
                    │  │  ┌────┴─────┐  ┌──────────┐       │  │
                    │  │  │  Skill   │  │Scheduler │       │  │
                    │  │  │  System  │  │  (Cron)  │       │  │
                    │  │  └──────────┘  └──────────┘       │  │
                    │  │  ┌──────────┐  ┌──────────┐       │  │
                    │  │  │ Trigger  │  │ Workflow │       │  │
                    │  │  │ Engine   │  │ Engine   │       │  │
                    │  │  └──────────┘  └──────────┘       │  │
                    │  └───────────────────────────────────┘  │
                    └──────────────────┬───────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │  claude -p       │
                              │  claude --resume │
                              │                  │
                              │  Your Max        │
                              │  Subscription    │
                              └────────┬─────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │  MCP Servers     │
                              │  Gmail           │
                              │  GitHub          │
                              │  Slack           │
                              │  Calendar        │
                              │  ...             │
                              └─────────────────┘
```

---

## What Gombwe Solves

### 1. Always-On Daemon

```
Without Gombwe:
  Open terminal → use Claude → close terminal → Claude stops

With Gombwe:
  gombwe start → runs 24/7 → monitors, schedules, triggers
  even when terminal is closed (--headless mode)
```

Gombwe runs as a persistent Node.js process. It keeps the gateway, scheduler, triggers, and channel connections alive. Use `gombwe start --headless` for daemon mode or `nohup gombwe start --headless &` to survive terminal closure.

### 2. Phone Access

```
┌─────────────────────────┐
│  Discord on your phone  │
│                         │
│  You: /email-digest     │
│                         │
│  Gombwe: Here are your  │
│  unread emails:         │
│  1. John (urgent)...    │
│  2. Newsletter...       │
│                         │
│  You: /task fix the     │
│  login bug              │
│                         │
│  Gombwe: Task started.. │
│  ...                    │
│  Gombwe: Fixed. The     │
│  null check on line 42  │
│  was missing...         │
└─────────────────────────┘
```

You're on the bus. You text gombwe on Discord. It runs Claude Code on your Mac at home. Results come back to your phone. No terminal, no laptop, no VPN.

### 3. Completion Loop (Retry + Continue + Verify)

```
┌──────────────────────────────────────────────────┐
│                 Completion Loop                   │
│                                                   │
│  ┌─────────┐                                     │
│  │ Prompt  │  "Build me a REST API"              │
│  └────┬────┘                                     │
│       ▼                                           │
│  ┌─────────┐  Wraps with: "NEVER ask questions.  │
│  │ Wrap    │  Make decisions. Don't stop halfway."│
│  └────┬────┘                                     │
│       ▼                                           │
│  ┌─────────┐  claude -p → captures session ID    │
│  │  Run    │─────────────────────────────────┐   │
│  └────┬────┘                                 │   │
│       ▼                                      │   │
│  ┌─────────┐  "I'll continue..." detected?   │   │
│  │Complete?│──Yes──▶ claude --resume "keep    │   │
│  └────┬────┘        going" (up to 5x)────────┘   │
│       │No                                         │
│       ▼                                           │
│  ┌─────────┐  Exit code != 0?                    │
│  │ Failed? │──Yes──▶ claude --resume "retry,     │
│  └────┬────┘        error was..." (up to 3x)──┐  │
│       │No                                     │  │
│       ▼                                       │  │
│  ┌─────────┐  claude --resume "verify:        │  │
│  │ Verify  │  run tests, check files,         │  │
│  └────┬────┘  fix issues"                     │  │
│       ▼                                       │  │
│  ┌─────────┐                                  │  │
│  │  Done   │  Only now marked complete        │  │
│  └─────────┘                                  │  │
│                                                   │
│  All steps use --resume = Claude remembers        │
│  EVERYTHING from prior steps                      │
└──────────────────────────────────────────────────┘
```

### 4. Event Triggers

```
Every 5 minutes:
  ┌──────────┐    ┌───────────────┐    ┌──────────┐
  │  Timer   │───▶│ Claude checks │───▶│TRIGGERED?│
  │  fires   │    │ "any new      │    │          │
  └──────────┘    │  emails from  │    └────┬─────┘
                  │  @client.com?"│         │
                  └───────────────┘    Yes  │  No
                                       │    │
                                       ▼    ▼
                                  ┌────────┐ (wait)
                                  │ Action │
                                  │"Summar-│
                                  │ize and │
                                  │draft   │
                                  │reply"  │
                                  └───┬────┘
                                      ▼
                                 ┌─────────┐
                                 │ Notify  │
                                 │discord  │
                                 │#alerts  │
                                 └─────────┘
```

### 5. Workflow Chains

```
Webhook: POST /api/webhook/github-pr
         │
         ▼
  Step 1: "Review the code changes"
         │
         │ output
         ▼
  Step 2: "Based on review: {{previous}},
           draft GitHub comments"
         │
         │ output
         ▼
  Step 3: "One-line summary"
         │
         │ output ──▶ discord:#github
         ▼
  Done
```

### 6. Custom Skills with Native Tools

```
┌─────────────────────────────────────────┐
│  SKILL.md                                │
│                                          │
│  name: system-health                     │
│  tools:                                  │
│    - name: disk     shell: "df -h"       │
│    - name: memory   shell: "vm_stat"     │
│    - name: cpu      shell: "ps aux"      │
│                                          │
│  Instructions:                           │
│  "Analyze the tool results and report    │
│   system health status..."               │
└──────────────────┬──────────────────────┘
                   │
                   ▼
  ┌────────────────────────────────────┐
  │ Gombwe executes tools directly    │
  │ (instant, no AI cost)             │
  │                                    │
  │  df -h        → "95% used"        │
  │  vm_stat      → "4GB free"        │
  │  ps aux       → "node 45% CPU"    │
  └────────────────┬───────────────────┘
                   │ results
                   ▼
  ┌────────────────────────────────────┐
  │ Claude analyzes (one call)        │
  │                                    │
  │  "Disk is critical at 95%.        │
  │   Clean ~/Downloads.              │
  │   Memory is fine.                 │
  │   Node process at 45% CPU —      │
  │   check for runaway task."        │
  └────────────────────────────────────┘
```

---

## Bundled Skills

| Skill | What it does | Needs MCP? | Has native tools? |
|-------|-------------|------------|-------------------|
| `/email-digest` | Summarize inbox by priority, draft urgent replies | Gmail | No |
| `/github-review` | PRs needing review, failing CI, stale PRs | GitHub | No |
| `/morning-briefing` | Calendar + email + code + priorities for the day | Multiple | No |
| `/code-review` | Review code for bugs, security, performance | No | No |
| `/deploy-check` | Pre-deployment checklist (tests, build, lint) | No | No |
| `/security-audit` | Scan for vulnerabilities and hardcoded secrets | No | No |
| `/system-health` | Check disk, memory, CPU, processes | No | Yes (4 tools) |
| `/git-digest` | Summarize recent git activity across repos | No | Yes (3 tools) |
| `/api-health` | Check if APIs and services are responding | No | Yes (3 tools) |
| `/web-monitor` | Monitor URLs for changes or price drops | Fetch/Brave | No |
| `/content-ideas` | Trending topics + content ideas for your niche | Brave Search | No |
| `/meeting-prep` | Briefing notes and talking points | Calendar | No |
| `/cleanup` | Find dead code, unused deps, temp files | No | No |

---

## Quick Start

```bash
# Install
git clone https://github.com/yourusername/claude-gombwe.git
cd claude-gombwe
npm install
npm run build
npm link

# Start
gombwe start
```

## All Commands

```bash
# Core
gombwe start                        # Interactive terminal + gateway
gombwe start --headless             # Daemon mode
gombwe run "do something"           # Run task, stream output
gombwe status                       # System status

# Chat commands (terminal, Discord, Telegram, web)
/help                               # All commands
/task build me an API               # Autonomous task
/build a landing page               # Autonomous task
/fix the login bug                  # Autonomous task
/email-digest                       # Run a skill
/new                                # Fresh conversation
/model opus                         # Switch model
/set discord.token TOKEN            # Configure from anywhere

# Services
gombwe services                     # List available services
gombwe connect github -e TOKEN=xxx  # Connect a service
gombwe connect gmail                # Connect Gmail (needs OAuth)

# Jobs
gombwe job "/email-digest" --schedule "0 8 * * *"  # Daily at 8am
gombwe jobs                         # List jobs

# Triggers
gombwe watch "name" --when "..." --do "..." --notify "discord:#alerts"
gombwe triggers                     # List triggers

# Workflows
gombwe workflow "name" --trigger "webhook:path" --steps '[...]'
gombwe workflows                    # List workflows
```

## Discord Setup

1. https://discord.com/developers/applications → New Application
2. Bot tab → enable Message Content Intent → Reset Token → copy
3. OAuth2 → scope: bot → permissions: Send Messages, Read History, View Channels → invite
4. `gombwe config --set channels.discord.botToken=YOUR_TOKEN`
5. Create channels: `#chat`, `#alerts`, `#daily`
6. Restart gombwe

## Gmail Setup

1. Google Cloud Console → New Project → Enable Gmail API
2. OAuth consent screen → External → add yourself as test user
3. Credentials → OAuth client ID → Desktop app → Download JSON
4. `mkdir ~/.gmail-mcp && mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json`
5. `npx @gongrzhe/server-gmail-autoauth-mcp auth` (browser sign-in)
6. `claude mcp add --transport stdio --scope user gmail -- npx @gongrzhe/server-gmail-autoauth-mcp`

## Gombwe vs OpenClaw vs Claude Code

| | Claude Code | Gombwe | OpenClaw |
|---|---|---|---|
| **Cost** | Subscription | Subscription | API ($1-5k/month) |
| **Always-on** | No | Yes | Yes |
| **Phone access** | No | Discord, Telegram | 30+ channels |
| **Completion loop** | No | Retry + continue + verify | Partial |
| **Event triggers** | No | Yes | Yes |
| **Workflows** | No | Yes | Yes |
| **Concurrent tasks** | 1 | Configurable | Yes |
| **Native tools** | No | Yes | Yes |
| **Conversation state** | Session-based | `--resume` (full context) | Stateless (resends history) |
| **Skills** | Built-in | 13 + custom | 5,700+ |
| **MCP servers** | Yes | Yes (same config) | No (own tool system) |

## Documentation

- [docs/WHY.md](docs/WHY.md) — Why this project exists
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Complete architecture guide
- [docs/COMPLETION-LOOP.md](docs/COMPLETION-LOOP.md) — How the retry/continue/verify loop works
- [docs/SKILLS.md](docs/SKILLS.md) — Skill format, native tools, creating custom skills
- [docs/API.md](docs/API.md) — REST API and WebSocket reference
- [SETUP.md](SETUP.md) — Step-by-step setup guide

## Tech Stack

TypeScript, Node.js, Express, WebSocket (ws), grammy (Telegram), discord.js (Discord), croner (cron), gray-matter (YAML), Claude Code CLI

## License

MIT
