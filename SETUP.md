# claude-gombwe Setup Guide

## Install

```bash
npm install -g claude-gombwe
```

## Quick Start

```bash
# Start gombwe (interactive terminal + dashboard + channels)
gombwe start

# Open dashboard
open http://127.0.0.1:18790

# Or send tasks from another terminal
gombwe run "build me a React landing page"
gombwe tasks
gombwe status
```

---

## Adding Discord

1. Create a bot at https://discord.com/developers/applications
2. Enable Message Content Intent in the Bot tab
3. Invite to your server via OAuth2 URL
4. Configure and restart:

```bash
gombwe config --set channels.discord.botToken=YOUR_BOT_TOKEN
```

## Adding Telegram

1. Message @BotFather on Telegram, send /newbot
2. Copy the bot token
3. Configure and restart:

```bash
gombwe config --set channels.telegram.botToken=YOUR_BOT_TOKEN
```

## Connecting Services (MCP)

```bash
gombwe connect github -e GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
gombwe connect gmail
gombwe connect slack -e SLACK_BOT_TOKEN=xoxb-xxx -e SLACK_TEAM_ID=T0xxx
gombwe connect brave-search -e BRAVE_API_KEY=BSA_xxx
```

## Scheduling Jobs

```bash
gombwe job "/morning-briefing" --schedule "0 8 * * *"
gombwe job "/email-digest" --schedule "*/30 * * * *"
gombwe jobs
```

## Event Triggers

```bash
gombwe watch "client-email" \
  --when "Check inbox for emails from @client.com" \
  --do "Summarize and draft a reply" \
  --notify "discord:#alerts"

gombwe triggers
```

## Adding Skills

Create `~/.claude-gombwe/skills/my-skill/SKILL.md`:

```yaml
---
name: my-skill
description: What it does
version: 1.0.0
user-invocable: true
---

Instructions for the agent when this skill is invoked.
```

## All Commands

```
gombwe start                    Interactive terminal + gateway + dashboard
gombwe start --headless         Daemon mode
gombwe run "prompt"             Run task, stream output
gombwe run "prompt" --no-wait   Fire and forget
gombwe tasks                    List tasks
gombwe status                   System status
gombwe config                   Show config
gombwe config --set key=val     Set config value
gombwe services                 List available services
gombwe connect <service>        Connect a service
gombwe job "prompt" --schedule  Schedule a recurring job
gombwe jobs                     List jobs
gombwe watch <name> --when --do Create event trigger
gombwe triggers                 List triggers
gombwe workflow <name>          Create workflow
gombwe workflows                List workflows
```

## How It Works

```
You (Terminal / Discord / Telegram / Web / Cron / Triggers)
    │
    ▼
┌──────────────────────────────────────────┐
│  Gombwe Gateway (:18790)                 │
│  ├─ Web dashboard                        │
│  ├─ Agent runtime (completion loop)      │
│  ├─ Channel adapters                     │
│  ├─ Skill system + native tools          │
│  ├─ Cron scheduler                       │
│  ├─ Event trigger engine                 │
│  ├─ Workflow engine                      │
│  └─ Session manager (--resume)           │
└──────────────────┬───────────────────────┘
                   │
                   ▼
             claude -p / claude --resume
             (your Max subscription)
```
