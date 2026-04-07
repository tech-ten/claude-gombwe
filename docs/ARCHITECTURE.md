# Architecture

## Overview

```
┌─────────────────────────────────────────────────┐
│                  User Interfaces                 │
│  Terminal (gombwe start)                         │
│  Web Dashboard (http://localhost:18790)           │
│  Discord Bot                                     │
│  Telegram Bot                                    │
│  CLI commands (gombwe run, gombwe job, etc.)      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│               Gateway (gateway.ts)                │
│                                                    │
│  Express HTTP server + WebSocket server            │
│  Port: 18790 (configurable)                        │
│                                                    │
│  Responsibilities:                                 │
│  - Route messages from channels to agent runtime   │
│  - Serve web dashboard (static files from /ui)     │
│  - REST API for tasks, sessions, jobs, triggers    │
│  - WebSocket for real-time updates to all clients  │
│  - Webhook endpoints for external triggers         │
│  - Command routing (/help, /task, /skills, etc.)   │
└──┬──────┬──────┬──────┬──────┬──────┬────────────┘
   │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼
Agent  Session  Skills Scheduler Triggers Workflows
```

## Core Components

### 1. Gateway (`src/gateway.ts`)

The central hub. A single Node.js process that owns everything:

- **HTTP server** — serves the web dashboard and REST API
- **WebSocket server** — pushes real-time events to all connected clients (dashboard, CLI)
- **Channel adapters** — receives messages from Discord, Telegram, web
- **Message router** — decides whether a message is a command, skill, task, or chat
- **Notify function** — routes output to specific channels (e.g., `discord:#alerts`)

All messages flow through the gateway regardless of source. The gateway decides what to do with them.

### 2. Agent Runtime (`src/agent.ts`)

Wraps the `claude` CLI. Two modes:

**Chat mode** (`agent.chat()`):
- Calls `claude -p "message" --output-format stream-json --verbose --dangerously-skip-permissions`
- Uses `--resume <sessionId>` for follow-up messages in the same conversation
- Claude keeps full internal state (every file read, command run, decision made)
- Returns the response and the session ID for next time

**Task mode** (`agent.runTask()`) — the completion loop:
1. Wraps the prompt with an autonomy instruction ("never ask questions, just do it")
2. Spawns `claude -p` 
3. Captures the session ID from output
4. If output looks incomplete → `--resume` with "keep going" (up to 5 times)
5. If process fails → retry with error context via `--resume` (up to 3 times)
6. When done → verification pass via `--resume` ("check your work, run tests, fix issues")
7. Only marks complete after verification

The completion loop is what makes gombwe different from just running `claude -p`. It keeps going until the work is actually done.

**Key flags used:**
- `--output-format stream-json` — structured output for parsing
- `--verbose` — required with stream-json
- `--dangerously-skip-permissions` — headless mode can't prompt for approvals
- `--resume <id>` — continue an existing conversation
- `--model <name>` — model selection

### 3. Session Manager (`src/session.ts`)

Tracks conversations across channels:

- Each channel + context gets a unique session key (e.g., `discord:guild123:channel456`, `telegram:user789:chat`)
- Sessions store the Claude CLI session ID for `--resume`
- Transcripts are stored as JSONL files in `~/.claude-gombwe/data/sessions/`
- Sessions have a mode: `chat` (conversational) or `task` (autonomous)

### 4. Channel Adapters (`src/channels/`)

Each adapter implements the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(sessionKey: string, message: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

**Web** (`web.ts`): Bridges the WebSocket to the gateway. Messages from the dashboard go through here.

**Telegram** (`telegram.ts`): Uses the `grammy` library. Each Telegram chat gets its own session. Task commands (`/task`, `/build`, etc.) get separate sessions so they don't pollute chat context. Registers commands with Telegram's native command picker.

**Discord** (`discord.ts`): Uses `discord.js`. Auto-discovers all text channels on startup. Supports named channel routing (`discord:#alerts`). Each channel is a separate conversation.

### 5. Skill System (`src/skills.ts`)

Skills are directories with a `SKILL.md` file (YAML frontmatter + markdown instructions):

```yaml
---
name: skill-name
description: What it does
tools:
  - name: tool-name
    type: shell
    command: "some command"
---
Instructions for Claude...
```

Skills are loaded from:
1. `~/.claude-gombwe/skills/` (user skills)
2. `./skills/` (project bundled skills)

Skills can have **native tools** — shell commands, HTTP requests, or scripts that execute directly without Claude. This is for mechanical operations (checking disk usage, fetching a URL) where AI isn't needed.

When a skill is invoked, the instructions are passed to Claude along with tool results.

### 6. Scheduler (`src/scheduler.ts`)

Cron-based job scheduling using the `croner` library:

- Jobs are persisted to `~/.claude-gombwe/data/cron-jobs.json`
- Survive daemon restarts
- Each job fires `agent.runTask()` with the configured prompt
- Jobs can be paused/resumed via API or dashboard

### 7. Event Triggers (`src/triggers.ts`)

"When X happens, do Y" — proactive behavior:

**Source types:**
- `poll_prompt` — periodically ask Claude "has X happened?" (e.g., "check my inbox for emails from @client.com")
- `webhook` — external HTTP POST triggers the action
- `file_watch` — fires when a file/directory changes (mtime tracking)
- `url_change` — fires when a web page changes

**When a trigger fires:**
1. Runs the action prompt through `agent.chat()`
2. Sends results to configured notification channels
3. Optionally chains follow-up actions

Triggers are persisted to `~/.claude-gombwe/data/triggers.json`.

### 8. Workflow Engine (`src/workflows.ts`)

Multi-step pipelines:

```
Trigger → Step 1 → Step 2 → Step 3
                ↓
          {{previous}} passes output between steps
```

Each step:
- Has a name and prompt
- Can reference `{{previous}}` to use the prior step's output
- Can have a condition (skipped if condition not met, evaluated by Claude)
- Can notify specific channels

Workflows are triggered by webhooks or can be run manually via API.

### 9. Config (`src/config.ts`)

Config lives at `~/.claude-gombwe/gombwe.json`:

```json
{
  "port": 18790,
  "host": "127.0.0.1",
  "dataDir": "~/.claude-gombwe/data",
  "skillsDirs": ["~/.claude-gombwe/skills", "./skills"],
  "agents": {
    "defaultModel": "claude-sonnet-4-6",
    "maxConcurrent": 5,
    "workingDir": "/Users/you"
  },
  "channels": {
    "telegram": { "botToken": "..." },
    "discord": { "botToken": "..." },
    "web": { "enabled": true }
  },
  "identity": {
    "name": "Gombwe"
  }
}
```

### 10. Service Setup (`src/setup.ts`)

Manages MCP server connections. `gombwe connect <service>` writes to `~/.claude/settings.json` — the same config file Claude Code reads. This means MCP servers configured through gombwe are available to all Claude Code sessions.

### 11. Proxy (`src/proxy.ts`)

OpenAI-compatible API proxy (experimental). Routes requests through `claude -p` so tools expecting the OpenAI API format can use your subscription. Includes model mapping and fallback chain. This was built as an experiment and is not the primary use case.

## Data Flow

### Chat message (e.g., from Discord):

```
Discord message
  → DiscordChannel.onMessage()
  → Gateway message handler
  → Is it a command? Check handleCommand()
  → Is session in task mode? Run agent.runTask()
  → Default: Run agent.chat() with --resume
  → Response sent back via channel.send()
  → Also broadcast via WebSocket to dashboard
```

### Task (e.g., `/task build an API`):

```
/task command received
  → Gateway handleCommand() matches 'task'
  → agent.runTask() called
  → Autonomy wrapper prepended to prompt
  → claude -p spawned → session ID captured
  → Output streamed via task:output events
  → If incomplete → claude --resume "keep going"
  → If failed → claude --resume "retry, previous error was..."
  → If done → claude --resume "verify your work"
  → task:completed event → response sent to channel
```

### Trigger (e.g., email monitor):

```
Polling interval fires (every N seconds)
  → agent.chat("Check inbox for emails from @client.com")
  → Claude uses Gmail MCP → checks → responds TRIGGERED or NOT_TRIGGERED
  → If TRIGGERED → run action prompt
  → Send result to configured notify channels (e.g., discord:#alerts)
```

## File Structure

```
claude-gombwe/
├── src/
│   ├── index.ts          # CLI entry point (commander)
│   ├── gateway.ts         # Central hub — HTTP, WebSocket, routing
│   ├── agent.ts           # Claude Code wrapper — chat + task with completion loop
│   ├── session.ts         # Session management — JSONL transcripts
│   ├── config.ts          # Config file management
│   ├── skills.ts          # SKILL.md parser + native tool executor
│   ├── scheduler.ts       # Cron job scheduling
│   ├── triggers.ts        # Event trigger engine
│   ├── workflows.ts       # Multi-step workflow engine
│   ├── setup.ts           # MCP service connection manager
│   ├── proxy.ts           # OpenAI-compatible API proxy
│   ├── types.ts           # TypeScript interfaces
│   └── channels/
│       ├── web.ts         # Web dashboard channel
│       ├── telegram.ts    # Telegram bot
│       └── discord.ts     # Discord bot
├── ui/
│   ├── index.html         # Dashboard HTML
│   ├── app.js             # Dashboard JavaScript
│   └── style.css          # Dashboard styles
├── skills/                # Bundled skills (13)
│   ├── email-digest/SKILL.md
│   ├── github-review/SKILL.md
│   ├── morning-briefing/SKILL.md
│   └── ... (10 more)
├── agents/
│   ├── AGENTS.md          # Agent operating instructions
│   └── IDENTITY.md        # Agent identity config
├── docs/
│   ├── WHY.md             # Why this project exists
│   └── ARCHITECTURE.md    # This file
├── package.json
├── tsconfig.json
├── SETUP.md               # Step-by-step setup guide
└── README.md              # Project overview
```
