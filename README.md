# claude-gombwe

An autonomous agent control panel powered by Claude Code — orchestrate AI tasks, triggers, workflows, and skills from anywhere.

*Gombwe (Shona): a guardian spirit medium — the vessel that channels higher powers.*

---

## Get Running in 60 Seconds

```bash
npm install -g claude-gombwe
gombwe start
```

That's it. You now have a dashboard at `http://localhost:18790` and an interactive terminal. Type anything.

---

## Real Examples — What You Can Do Right Now

### Check your email from Discord

```
You (Discord):  /email-digest
Gombwe:          3 urgent, 7 important, 12 low priority
                 URGENT: John from Acme Corp — "Q2 budget needs approval by Friday"
                 Suggested reply: "Hi John, I'll review and approve by EOD Thursday..."
```

**Setup required:** Connect Gmail (one-time, 5 minutes — see Gmail Setup below).

### Build something while you're on the bus

```
You (Discord):  /build a REST API with user authentication and JWT tokens
Gombwe:          Task started...
                 [runs autonomously, retries if it fails, verifies when done]
                 Created 8 files: routes, middleware, models, tests...
```

**Setup required:** None. Works immediately.

### Get a morning briefing every day at 8am

```bash
gombwe job "/morning-briefing" --schedule "0 8 * * *"
```

Every morning, gombwe checks your calendar, email, and GitHub, then sends a prioritized summary to your Discord `#daily` channel.

**Setup required:** Connect Gmail and/or GitHub for richer briefings.

### Watch for important events

```bash
gombwe watch "client-email" \
  --when "Check inbox for new emails from @bigclient.com" \
  --do "Summarize the email and draft a reply" \
  --notify "discord:#alerts" \
  --every 300
```

Every 5 minutes, gombwe checks your inbox. When your client emails, you get an alert on Discord with a summary and draft reply.

### Chain multiple steps together

```bash
gombwe workflow "weekly-report" \
  --trigger "webhook:weekly" \
  --steps '[
    {"name":"gather","prompt":"Collect this weeks git commits, closed issues, and merged PRs across all repos"},
    {"name":"analyze","prompt":"Based on: {{previous}}, identify the top 3 achievements and any blockers"},
    {"name":"write","prompt":"Write a professional weekly status report from: {{previous}}","notify":["discord:#reports"]}
  ]'
```

Three steps, each feeding into the next. The final report lands in your Discord.

---

## Connecting Services

Gombwe uses Claude Code's MCP servers to connect to external services. There are two categories:

### Built-in MCP servers (Claude handles automatically)

These are available through Claude's own integrations. You may just need to authenticate once:

| Service | What it does | How to enable |
|---------|-------------|---------------|
| Gmail (claude.ai) | Read, search, send email | Authenticate via `/mcp` in Claude Code |
| Google Calendar | Read and manage events | Authenticate via `/mcp` in Claude Code |
| Web browsing | Fetch URLs, search the web | Available by default |
| File system | Read and write local files | Available by default |

For these, you don't need to install anything. Claude Code may prompt you to authorize on first use.

### External MCP servers (you configure)

For deeper integration or services Claude doesn't have built-in, you install MCP servers yourself:

```bash
# GitHub — PRs, issues, repos, code search
gombwe connect github -e GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here

# Slack — read/send messages across channels
gombwe connect slack -e SLACK_BOT_TOKEN=xoxb-your-token -e SLACK_TEAM_ID=T0your-id

# Brave Search — web search with current results
gombwe connect brave-search -e BRAVE_API_KEY=BSA_your-key

# Persistent memory — knowledge graph across conversations
gombwe connect memory
```

**When to use external MCP servers:**

- **GitHub** — if you want gombwe to review PRs, check CI status, or manage issues automatically
- **Slack** — if your team uses Slack and you want gombwe to summarize channels or send updates
- **Brave Search** — if you want skills like `/content-ideas` to find real trending topics
- **Memory** — if you want gombwe to remember facts across conversations and restarts

Run `gombwe services` to see all available services and what they need.

### Gmail Setup (external MCP — full control)

If you want more control than the built-in Gmail integration, set up your own:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable the **Gmail API** (APIs & Services > Library > search "Gmail API" > Enable)
3. Set up **OAuth consent screen** (APIs & Services > OAuth consent screen > External > add your email as test user)
4. Create **OAuth credentials** (APIs & Services > Credentials > Create > OAuth client ID > Desktop app > Download JSON)
5. Install and authenticate:

```bash
mkdir -p ~/.gmail-mcp
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
npx @gongrzhe/server-gmail-autoauth-mcp auth
claude mcp add --transport stdio --scope user gmail -- npx @gongrzhe/server-gmail-autoauth-mcp
```

After this, gombwe can read your email, draft replies, and send messages — all from Discord, Telegram, or scheduled jobs.

---

## Setting Up Discord

This is how you control gombwe from your phone.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and create a new application
2. Go to the **Bot** tab, enable **Message Content Intent**, and copy the bot token
3. Go to **OAuth2**, check **bot** scope, select permissions (Send Messages, Read History, View Channels), and use the generated URL to invite the bot to your server
4. Configure gombwe:

```bash
gombwe config --set channels.discord.botToken=YOUR_TOKEN
```

5. Create channels in your Discord server for organized routing:
   - `#chat` — talk to gombwe
   - `#alerts` — automated notifications from triggers
   - `#daily` — scheduled reports and briefings

6. Restart gombwe. The bot connects automatically and discovers all channels.

### Using Discord

Just type in any channel. Gombwe responds.

```
#chat:    What time is it in Tokyo?
#chat:    /task refactor the auth module
#chat:    /email-digest
#alerts:  (gombwe posts here automatically when triggers fire)
#daily:   (morning briefing appears here at 8am)
```

Each channel is a separate conversation with its own memory.

---

## Setting Up Telegram

1. Message [@BotFather](https://t.me/botfather) on Telegram and send `/newbot`
2. Copy the bot token
3. Configure:

```bash
gombwe config --set channels.telegram.botToken=YOUR_TOKEN
```

4. Restart gombwe and message your bot.

---

## All Commands

### Terminal

```bash
gombwe start                        # Interactive terminal + gateway + dashboard
gombwe start --headless             # Daemon mode (no prompt)
gombwe run "do something"           # Run a task, stream output to terminal
gombwe run "do something" --no-wait # Fire and forget
gombwe status                       # System overview
gombwe config                       # Show configuration
gombwe config --set key=value       # Change a setting
gombwe services                     # Available services
gombwe connect <service>            # Connect a service
gombwe job "prompt" --schedule "cron"  # Schedule a recurring job
gombwe jobs                         # List scheduled jobs
gombwe watch <name> --when --do     # Create an event trigger
gombwe triggers                     # List active triggers
gombwe workflow <name> ...          # Create a multi-step workflow
gombwe workflows                    # List workflows
```

### Chat (works in terminal, Discord, Telegram, and web dashboard)

Type `/` to see all commands with autocomplete. Key ones:

```
/help                   All available commands
/new                    Start a fresh conversation
/task <description>     Run autonomous task (retries, continues, verifies)
/build <description>    Same as /task
/fix <description>      Same as /task
/model opus             Switch to Opus (or sonnet, haiku)
/set discord.token X    Configure from chat
/email-digest           Check and summarize email
/github-review          Review PRs and issues
/morning-briefing       Full daily briefing
/code-review            Review code changes
/deploy-check           Pre-deploy checklist
/security-audit         Security scan
/system-health          System resource check
/git-digest             Recent git activity
```

---

## Skills

13 built-in skills. Type the name in any chat to run it.

| Skill | What it does | Needs |
|-------|-------------|-------|
| `/email-digest` | Inbox summary by priority with draft replies | Gmail |
| `/github-review` | PRs needing review, failing CI, stale PRs | GitHub |
| `/morning-briefing` | Calendar + email + code + daily priorities | Gmail, Calendar |
| `/code-review` | Review code for bugs, security, performance | Nothing |
| `/deploy-check` | Pre-deployment checklist (tests, build, lint) | Nothing |
| `/security-audit` | Scan for vulnerabilities and secrets | Nothing |
| `/system-health` | Disk, memory, CPU, top processes | Nothing |
| `/git-digest` | Recent commits, uncommitted changes, branches | Nothing |
| `/api-health` | Check if services are responding | Nothing |
| `/web-monitor` | Monitor URLs for changes or price drops | Brave Search |
| `/content-ideas` | Trending topics and content ideas | Brave Search |
| `/meeting-prep` | Briefing notes for upcoming meetings | Calendar |
| `/cleanup` | Find dead code, unused deps, temp files | Nothing |

### Creating your own skills

Create a folder in `~/.claude-gombwe/skills/` with a `SKILL.md` file:

```yaml
---
name: standup
description: Generate daily standup update from git activity
version: 1.0.0
user-invocable: true
tools:
  - name: recent-work
    type: shell
    command: "git log --oneline --since='yesterday' --author=$(git config user.email)"
---

Based on the recent git commits above, write a concise daily standup update:
- What I did yesterday
- What I'm doing today (infer from branch names and recent changes)
- Any blockers (look for failed tests or TODO comments)
```

Skills with `tools` execute shell commands, HTTP requests, or scripts directly — no AI cost for the data gathering. Claude only gets called once to analyze the results.

---

## Architecture

```
Phone / Terminal / Browser / Cron / Triggers
    |
    v
Gombwe Gateway (localhost:18790)
    |-- Channel adapters (Discord, Telegram, Web)
    |-- Agent runtime (completion loop)
    |-- Session manager (claude --resume)
    |-- Skill system + native tools
    |-- Cron scheduler
    |-- Event trigger engine
    |-- Workflow engine
    |-- REST API + WebSocket
    |-- Web dashboard
    |
    v
claude -p / claude --resume (your subscription)
    |
    v
MCP Servers (Gmail, GitHub, Slack, Calendar...)
```

## How the Completion Loop Works

When you fire a task, gombwe doesn't just run it once:

1. Wraps your prompt with autonomy instructions — "don't ask questions, just decide"
2. Runs `claude -p` and captures the session ID
3. If output looks incomplete — sends "keep going" via `--resume` (up to 5 times)
4. If process fails — retries with error context via `--resume` (up to 3 times)
5. When done — runs a verification pass via `--resume` ("check your work, run tests, fix issues")
6. Only marks complete after verification passes

Every step uses `--resume` so Claude remembers everything — every file read, command run, and decision made.

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Complete technical architecture
- [docs/COMPLETION-LOOP.md](docs/COMPLETION-LOOP.md) — How retry/continue/verify works
- [docs/SKILLS.md](docs/SKILLS.md) — Skill format, native tools, creating custom skills
- [docs/API.md](docs/API.md) — REST API and WebSocket reference
- [docs/WHY.md](docs/WHY.md) — Project motivation

## License

MIT
