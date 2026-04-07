# claude-gombwe Setup Guide

## What is this?

claude-gombwe gives you OpenClaw-like capabilities using your Claude Max subscription.
Zero API costs. Two ways to use it:

### Option A: Use gombwe standalone (simpler)
The built-in dashboard, Telegram/Discord bots, cron scheduler, multi-agent task runner.

### Option B: Use OpenClaw through gombwe's proxy (full OpenClaw experience)
gombwe runs an OpenAI-compatible API server that routes all LLM calls through
`claude -p` (your subscription). OpenClaw sees it as a normal LLM API.

---

## Quick Start (Option A — standalone)

```bash
# 1. Start everything
gombwe up

# 2. Open dashboard
open http://127.0.0.1:18790/ui

# 3. Send tasks from CLI
gombwe run "build me a React landing page"
gombwe run "clean up all TODO comments in this project"
gombwe tasks
```

## Quick Start (Option B — with OpenClaw)

```bash
# 1. Start gombwe (includes the API proxy)
gombwe up

# 2. Install OpenClaw
npm install -g openclaw

# 3. Configure OpenClaw to use the proxy instead of Anthropic API
openclaw config set ai.provider "openai"
openclaw config set ai.model "claude-via-subscription"
openclaw config set ai.baseURL "http://127.0.0.1:18791/v1"
openclaw config set ai.apiKey "not-needed"

# 4. Start OpenClaw — it now uses your Max subscription
openclaw start
```

---

## Adding Telegram (control from your phone)

```bash
# 1. Create a bot: message @BotFather on Telegram, send /newbot
# 2. Copy the bot token
# 3. Configure:
gombwe config --set channels.telegram.botToken=YOUR_BOT_TOKEN

# 4. Restart:
gombwe up

# 5. Message your bot on Telegram:
#    "build me a REST API for managing todos"
#    It runs autonomously and messages you back when done.
```

## Adding Discord

```bash
# 1. Create a bot at https://discord.com/developers/applications
# 2. Copy the bot token
# 3. Configure:
gombwe config --set channels.discord.botToken=YOUR_BOT_TOKEN

# 4. Restart:
gombwe up
```

## Scheduling tasks (cron)

From the dashboard or CLI:

```bash
# Run tests every morning at 9am
curl -X POST http://127.0.0.1:18790/api/cron \
  -H "Content-Type: application/json" \
  -d '{"expression": "0 9 * * *", "prompt": "run all tests and report failures"}'

# Check for security updates weekly
curl -X POST http://127.0.0.1:18790/api/cron \
  -H "Content-Type: application/json" \
  -d '{"expression": "0 10 * * 1", "prompt": "check for outdated npm packages and update safe ones"}'
```

## Adding skills

Create a folder in `~/.claude-gombwe/skills/` with a `SKILL.md` file:

```
~/.claude-gombwe/skills/my-skill/SKILL.md
```

Format:
```yaml
---
name: my-skill
description: What it does
version: 1.0.0
user-invocable: true
---

Instructions for the agent when this skill is invoked.
Use /my-skill in chat to trigger it.
```

## All commands

```
gombwe up                  Start everything (gateway + proxy + channels)
gombwe start               Start gateway only
gombwe proxy               Start API proxy only
gombwe run "prompt"        Send a task
gombwe tasks               List tasks
gombwe tasks --status running  Filter tasks
gombwe status              System status
gombwe config              Show config
gombwe config --set key=val  Set config value
```

## How it works

```
You (Telegram / Discord / Web / CLI / Cron / OpenClaw)
    │
    ▼
┌──────────────────────────────────────────┐
│  claude-gombwe gateway (:18790)          │
│  ├─ Web dashboard                        │
│  ├─ Task manager (retry + continue +     │
│  │   verify loop)                        │
│  ├─ Channel adapters                     │
│  ├─ Skill system                         │
│  ├─ Cron scheduler                       │
│  └─ Session manager                      │
├──────────────────────────────────────────┤
│  claude-gombwe proxy (:18791)            │
│  └─ OpenAI-compatible API                │
│     (for OpenClaw / other tools)         │
└──────────────┬───────────────────────────┘
               │
               ▼
         claude -p "..."
         (your Max subscription)
```
