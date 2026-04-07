# claude-gombwe

An autonomous agent control panel powered by Claude Code.

*Gombwe (Shona): a guardian spirit medium — the vessel that channels higher powers.*

---

## The Problem

Claude Code is the most capable AI coding tool available. But it's session-based — you open a terminal, work with it, close the terminal, and it stops. It can't monitor your email while you sleep. It can't alert you on Discord when your CI breaks. It can't run five tasks simultaneously while you're on the bus.

What if Claude Code could work for you 24/7 — from your phone, on a schedule, watching for events, retrying until the job is actually done?

## The Solution

Gombwe is an orchestration layer on top of Claude Code. It adds what Claude Code is missing:

```
              The gap                      How gombwe fills it
              ───────                      ───────────────────
              Always-on daemon                  Persistent Node.js gateway
              Phone access                      Discord and Telegram bots
              Auto-retry on failure             Completion loop (3 retries)
              Auto-continue incomplete work     Detects and continues (5x)
              Verify results                    --resume verification pass
              Event-driven triggers             Poll, webhook, file watch
              Multi-step workflows              Chained steps with {{previous}}
              Concurrent tasks                  Configurable parallelism
              Web dashboard                     Real-time monitoring UI
              Native tools                      Shell, HTTP, script execution
              Scheduled automation              Cron-based job scheduler
```

The intelligence is all Claude. Gombwe just makes it reachable from anywhere and able to run autonomously.

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
                    │  Channel Adapters                        │
                    │  Message Router                          │
                    │  Agent Runtime (completion loop)         │
                    │  Session Manager (--resume)              │
                    │  Skill System (SKILL.md + native tools)  │
                    │  Cron Scheduler                          │
                    │  Event Trigger Engine                    │
                    │  Workflow Engine                         │
                    │  REST API + WebSocket                    │
                    │  Web Dashboard                           │
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
                              │  Gmail, GitHub   │
                              │  Slack, Calendar │
                              └─────────────────┘
```

---

## Key Features

### Always-On Daemon

Gombwe runs as a persistent process. It keeps your channels, scheduler, triggers, and dashboard alive — even when you close the terminal.

### Phone Access

Message gombwe from Discord or Telegram on your phone. It runs Claude Code on your machine and sends results back. No terminal, no laptop, no VPN.

### Completion Loop

When you fire a task, gombwe doesn't just run it once:

```
  Prompt → Autonomy wrap → Run → Incomplete? → Continue (up to 5x)
                                  Failed?    → Retry (up to 3x)
                                  Done?      → Verify via --resume
```

Every step uses `--resume` — Claude remembers everything from prior steps, including files read and commands run.

### Event Triggers

```bash
gombwe watch "client-email" \
  --when "Check inbox for emails from @client.com" \
  --do "Summarize and draft a reply" \
  --notify "discord:#alerts"
```

### Workflow Chains

Multi-step pipelines where each step's output feeds into the next:

```bash
gombwe workflow "pr-review" \
  --trigger "webhook:github-pr" \
  --steps '[
    {"name":"review","prompt":"Review the code changes"},
    {"name":"comment","prompt":"Draft comments based on: {{previous}}"},
    {"name":"notify","prompt":"One-line summary","notify":["discord:#dev"]}
  ]'
```

### Custom Skills with Native Tools

Skills are markdown files with optional executable tools:

```yaml
---
name: system-health
tools:
  - name: disk
    type: shell
    command: "df -h / | tail -1"
---
Analyze the tool results and report system health.
```

Native tools execute instantly without AI cost. Claude only gets called once to analyze the results.

---

## Bundled Skills

| Skill | What it does |
|-------|-------------|
| `/email-digest` | Summarize inbox by priority, draft urgent replies |
| `/github-review` | PRs needing review, failing CI, action items |
| `/morning-briefing` | Calendar + email + code + priorities |
| `/code-review` | Review code for bugs, security, performance |
| `/deploy-check` | Pre-deployment checklist |
| `/security-audit` | Scan for vulnerabilities |
| `/system-health` | Check disk, memory, CPU, processes |
| `/git-digest` | Summarize recent git activity |
| `/api-health` | Check if APIs are responding |
| `/web-monitor` | Monitor URLs for changes |
| `/content-ideas` | Trending topics + content ideas |
| `/meeting-prep` | Briefing notes for meetings |
| `/cleanup` | Find dead code, unused deps, temp files |

---

## Quick Start

```bash
npm install -g claude-gombwe
gombwe start
```

Or from source:

```bash
git clone https://github.com/tech-ten/claude-gombwe.git
cd claude-gombwe
npm install && npm run build && npm link
gombwe start
```

## Commands

```bash
# Core
gombwe start                        # Interactive terminal + gateway
gombwe start --headless             # Daemon mode
gombwe run "do something"           # Run task, stream output
gombwe status                       # System status

# Chat (terminal, Discord, Telegram, web)
/help                               # All commands
/task build me an API               # Autonomous task
/build a landing page               # Autonomous task
/fix the login bug                  # Autonomous task
/email-digest                       # Run a skill
/new                                # Fresh conversation
/model opus                         # Switch model
/set discord.token TOKEN            # Configure

# Services
gombwe connect github -e GITHUB_PERSONAL_ACCESS_TOKEN=xxx
gombwe connect gmail
gombwe connect slack -e SLACK_BOT_TOKEN=xxx -e SLACK_TEAM_ID=xxx

# Scheduling
gombwe job "/email-digest" --schedule "0 8 * * *"
gombwe jobs

# Triggers
gombwe watch "name" --when "..." --do "..." --notify "discord:#alerts"
gombwe triggers

# Workflows
gombwe workflow "name" --trigger "webhook:path" --steps '[...]'
gombwe workflows
```

## Discord Setup

1. Create a bot at discord.com/developers/applications
2. Enable Message Content Intent
3. Invite to your server
4. `gombwe config --set channels.discord.botToken=TOKEN`
5. Restart gombwe

## Gmail Setup

1. Google Cloud Console → New Project → Enable Gmail API
2. OAuth consent screen → External → add yourself as test user
3. Credentials → OAuth client ID → Desktop app → Download JSON
4. `mkdir ~/.gmail-mcp && mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json`
5. `npx @gongrzhe/server-gmail-autoauth-mcp auth`
6. `claude mcp add --transport stdio --scope user gmail -- npx @gongrzhe/server-gmail-autoauth-mcp`

## Documentation

- [docs/WHY.md](docs/WHY.md) — Project motivation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Technical architecture
- [docs/COMPLETION-LOOP.md](docs/COMPLETION-LOOP.md) — Retry/continue/verify mechanism
- [docs/SKILLS.md](docs/SKILLS.md) — Skill format and native tools
- [docs/API.md](docs/API.md) — REST API and WebSocket reference

## Tech Stack

TypeScript, Node.js, Express, WebSocket, grammy, discord.js, croner, gray-matter, Claude Code CLI

## License

MIT
