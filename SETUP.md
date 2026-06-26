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

## Keeping gombwe running (auto-start on boot)

`gombwe start --headless` runs the daemon in the foreground (gateway + dashboard + channels, no interactive REPL) so the OS can supervise it. Use the **native service manager**: a **launchd LaunchAgent** on macOS, a **systemd** unit on Linux. One hop, launchd/systemd → gombwe, no pm2. It restarts gombwe if it crashes (`KeepAlive`) and brings it back on login/boot (`RunAtLoad`).

> **Why not pm2?** It was tried and dropped. On macOS the policy scanner spawns `claude -p`, whose Claude **subscription** token lives in your **login keychain**. Only a process inside your login (Aqua) session can read it — so gombwe must run as a per-user **LaunchAgent**, not a system LaunchDaemon (a Daemon runs in a different security session and can't reach the keychain, which silently breaks AI classification unless you switch to a billed `ANTHROPIC_API_KEY`). pm2's extra supervisor hop added nothing over launchd here.

### macOS — launchd LaunchAgent

The repo ships an installer template at [`deploy/launchd/com.gombwe.daemon.plist`](deploy/launchd/com.gombwe.daemon.plist). Fill in the `@…@` placeholders (`@NODE_BIN@`, `@GOMBWE_DIST@`, `@GOMBWE_REPO@`, `@HOME@`) and install it — **no sudo needed for a user agent**:

```bash
# render the template (example values — adjust to your paths)
sed -e "s|@NODE_BIN@|$(which node)|" \
    -e "s|@GOMBWE_DIST@|$(npm root -g)/claude-gombwe/dist|" \
    -e "s|@GOMBWE_REPO@|$HOME/code/claude-gombwe|" \
    -e "s|@HOME@|$HOME|g" \
    deploy/launchd/com.gombwe.daemon.plist > ~/Library/LaunchAgents/com.gombwe.daemon.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gombwe.daemon.plist
```

It **must** run `start --headless` — plain `start` opens a REPL that dies with no TTY and triggers a KeepAlive restart loop.

> ⚠️ **Login, not boot:** a LaunchAgent starts at **login**, not at the login window. On a FileVault host that's moot — someone must unlock at the console each boot anyway, and that unlock logs them in, which fires the Agent. If you genuinely need pre-login start *and* AI classification, that needs a billed `ANTHROPIC_API_KEY` + a system LaunchDaemon instead. (The Cloudflare tunnel differs — it's a system LaunchDaemon that starts before login. See [cloudflare-setup.md](docs/cloudflare-setup.md).)

### Linux — systemd

```ini
# /etc/systemd/system/gombwe.service  (or ~/.config/systemd/user/ for a user unit)
[Unit]
Description=gombwe daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/claude-gombwe/dist/index.js start --headless
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gombwe
```

### Managing the service (macOS)

```bash
launchctl list | grep com.gombwe.daemon      # is it running? (PID, last exit code)
launchctl kickstart -k gui/$(id -u)/com.gombwe.daemon   # restart (after npm run build or config change)
launchctl bootout gui/$(id -u)/com.gombwe.daemon        # stop + unload
tail -f ~/.claude-gombwe/gombwe.out.log       # logs (stderr: gombwe.err.log)
```

After any code or config change: `npm run build` (if you edited source) then `launchctl kickstart -k gui/$(id -u)/com.gombwe.daemon`.

> If `dashboard.gombwe.com` returns **502 / Bad Gateway**, the tunnel is up but gombwe itself isn't — the tunnel and gombwe are **separate services**. Check `launchctl list | grep gombwe`. (Tunnel setup: [cloudflare-setup.md](docs/cloudflare-setup.md).)

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
