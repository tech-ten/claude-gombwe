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
gombwe grocery-setup            One-time Woolworths & Coles login
gombwe up                       Start everything (gateway + proxy + channels)
```

### Family commands (in chat — Discord, Telegram, web)

```
/dinner <day> <meal>    Add dinner (e.g. /dinner wed Chicken curry)
/breakfast <day> <meal> Add breakfast
/lunch <day> <meal>     Add lunch
/list                   View shopping list
/list milk, eggs        Add items to list
/buy                    Order everything
/buy hair remover       Order specific items
/meals                  View weekly plan, grocery list, pantry
```

Or just say it naturally: "put butter chicken on Saturday dinner", "we need milk and eggs".

### Working directory (in chat — Discord, Telegram, web)

```
/pwd                    Show current working directory for this session
/cd <path>              Set working directory for this session (persists)
/cd                     Reset to the default from gombwe.json
/in <path> <message>    One-shot: run <message> in <path>, session default unchanged
```

Resolution order at every message: `/in` override → session `/cd` → `config.agents.workingDir`. `~` and relative paths are expanded; gombwe rejects paths that don't exist or aren't directories. Useful when you want a Discord channel pinned to one project but occasionally peek elsewhere.

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
│  ├─ Family commands (/dinner, /list, /buy)│
│  ├─ Skill system + native tools          │
│  ├─ Cron scheduler                       │
│  ├─ Event trigger engine                 │
│  ├─ Workflow engine                      │
│  └─ Session manager (--resume)           │
└──────────────────┬───────────────────────┘
                   │
                   ▼
             claude -p / claude --resume
             + --mcp-config (gombwe-family)
             (your Max subscription)
```

## Development

If you're hacking on gombwe itself (not just installing it):

```bash
git clone https://github.com/tech-ten/claude-gombwe.git
cd claude-gombwe
npm install
npm link              # makes the global `gombwe` command point at this dir
npm run build         # compiles src/ → dist/ (and chmods dist/index.js)
gombwe start          # runs the local code
```

After every source change, `npm run build` is enough — the npm link means `gombwe start` immediately runs the updated `dist/index.js`. No reinstall needed.

### Releasing a new version

Releases are published to npm via GitHub Actions trusted publishing (OIDC). No tokens to manage; provenance attestation is attached to every release.

```bash
npm version patch                          # bumps package.json and tags
git push origin main --tags
gh release create vX.Y.Z --target main --generate-notes
```

Creating the GitHub Release triggers `.github/workflows/publish.yml`, which:

1. Checks out the tag, sets up Node 24 (npm 11.x — needed for the trusted-publishing OIDC handshake)
2. Builds, then runs `npm publish --access public --provenance`
3. Presents its OIDC identity to npm; npm verifies it matches the trusted-publisher config (publisher: GitHub Actions, repo: `tech-ten/claude-gombwe`, workflow: `publish.yml`, environment: `npm`)

If the workflow fails with `npm error 404 ... PUT ...claude-gombwe`, the OIDC identity wasn't accepted — check the trusted-publisher config on npmjs.com → package → Settings → Trusted Publisher matches exactly (case-sensitive, filename only, no path).
