# Why claude-gombwe exists

## The problem

Claude Code is the most capable AI coding tool available. With MCP servers, it can connect to Gmail, GitHub, Slack, and virtually any service. But it has a fundamental limitation: it's session-based.

You open a terminal, work with Claude, close the terminal, and it stops. There's no way to:
- Have it monitor your email and alert you when something important arrives
- Run tasks from your phone while you're away from your computer
- Schedule recurring automation (daily briefings, weekly reports)
- Fire and forget complex tasks that retry on failure and verify their own work
- React to events proactively ("when CI breaks, investigate and notify me")

## The solution

Gombwe adds an orchestration layer on top of Claude Code that fills these gaps. It's not a replacement — it uses Claude Code as its engine. Everything runs through `claude -p` and `claude --resume`, using your existing subscription.

The key architectural insight: `--resume` preserves Claude's full internal state across calls — every file read, every command run, every decision made. This enables a completion loop (retry, continue, verify) that's more capable than approaches that rely on resending conversation history.

## The name

"Gombwe" is a Shona word meaning a guardian spirit medium — the vessel that channels higher powers. Claude is the power, gombwe is the medium.

## What gombwe adds to Claude Code

| Capability | Claude Code | With Gombwe |
|---|---|---|
| Always-on daemon | No | Yes |
| Phone access (Discord, Telegram) | No | Yes |
| Auto-retry on failure | No | Yes (3 attempts) |
| Auto-continue incomplete work | No | Yes (5 continuations) |
| Verification pass | No | Yes (via --resume) |
| Event triggers | No | Yes |
| Multi-step workflows | No | Yes |
| Concurrent tasks | No | Configurable |
| Web dashboard | No | Yes |
| Native tools (no AI cost) | No | Yes |
| Scheduled jobs | Partial | Full cron support |
