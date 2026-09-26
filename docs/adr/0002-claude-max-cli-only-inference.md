# 2. Inference stays on the Claude Code CLI under Claude Max

## Status

Accepted, 2026-09-27.

## Context

Every new subsystem in this build needs a model: reflection over yesterday's transcripts, goal planning from a chat request, desktop script classification when the pattern list is unsure, and later semantic memory recall. The obvious engineering move is a provider abstraction with an API key, so any model can be swapped in.

Gombwe already spawns the Claude Code CLI for chat and tasks, and the owner pays for Claude Max. Adding metered API calls would introduce a per-token bill on a system designed to run continuously, plus key management, rate limit handling and a second code path that behaves differently from the one people actually use.

## Decision

All inference goes through the Claude Code CLI under the owner's Claude Max subscription. There is no provider abstraction and no paid inference or media API. New integrations use free tiers and infrastructure the household already owns: the WhatsApp Cloud API free tier, AWS SES on the existing account, and the Cloudflare Tunnel and Access already in place. Voice notes transcribe only if a local binary is present.

## Consequences

Running cost stays flat. Model behaviour is identical across chat, tasks, goals and reflection. Capability is bounded by what the CLI can do, so concurrency and long prompts are limited by the subscription. The CLI must also be able to read the owner's subscription credentials wherever gombwe is deployed, which constrains how the process is launched. A subscription lapse stops all reasoning.

## Alternatives considered

The Claude API with a key for background jobs. Rejected for cost and a second divergent path. A local model for cheap classification. Rejected as more machinery than the pattern list needs.
