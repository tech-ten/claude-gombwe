# Why claude-gombwe exists

## The problem

In April 2026, Anthropic blocked third-party agent frameworks (most notably OpenClaw) from using Claude Max subscriptions. OpenClaw users who were paying $200/month suddenly faced $1,000-5,000/month in API costs.

OpenClaw was popular because it turned Claude from "a chatbot you talk to" into "a personal assistant that works for you 24/7." It ran as a daemon, connected to 30+ messaging platforms, had 5,700+ community skills, and could act proactively — monitoring your email, checking your repos, alerting you to events.

The question was: can you get those capabilities using your legitimate Claude Max subscription?

## The answer

Yes. Claude Code (Anthropic's official CLI) is part of your subscription. It supports:
- Headless mode (`claude -p`) for programmatic use
- `--resume` for persistent conversations across calls
- MCP servers for connecting to Gmail, GitHub, Slack, etc.
- Built-in tools for file operations, shell commands, web access

What Claude Code doesn't have:
- A persistent daemon (it's session-based — exits when you close the terminal)
- Phone access (no Telegram, Discord, WhatsApp)
- Event-driven triggers ("when X happens, do Y")
- Multi-step workflow chains
- A web dashboard
- Auto-retry and verification loops

**Gombwe adds exactly these missing pieces on top of Claude Code.** It's an orchestration layer — not an AI replacement. The intelligence is all Claude. Gombwe just makes it reachable from anywhere and able to run autonomously.

## The name

"Gombwe" is a Shona word meaning a guardian spirit medium — the vessel that channels higher powers. Claude is the power, gombwe is the medium.

## How it relates to OpenClaw

Same architecture pattern. Different execution engine.

| | OpenClaw | Gombwe |
|---|---|---|
| AI engine | Raw Anthropic/OpenAI API | Claude Code CLI (`claude -p`) |
| Payment | Per-token API costs | Subscription (flat rate) |
| Conversation state | Stateless (resends full history every call) | `--resume` (Claude keeps full internal state) |
| Tools | Defined in API requests | MCP servers + native tools |
| Scale | 30+ channels, 5,700 skills, millions of users | 3 channels, 13 skills, built for personal use |

Gombwe has a structural advantage in conversation management (`--resume` vs stateless API), but OpenClaw has a massive ecosystem advantage (5,700 community skills vs 13).
