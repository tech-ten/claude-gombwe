# 15. A nightly reflection proposes memory rather than writing it inline

## Status

Accepted, 2026-09-27.

## Context

Memory is only useful if it fills up without anyone maintaining it. People state preferences in passing, mid-conversation about something else, and will not stop to run a remember command. So something has to read conversations and decide what was worth keeping.

Doing that during a conversation is the obvious approach and the wrong one. It puts a model call on the critical path of every message, judges a fact before the conversation that qualifies it has finished, and writes constantly with no chance to review.

## Decision

A built-in cron job at 02:00 Australia/Melbourne reads the previous day's transcripts and sends them to Claude together with the current memory and the tombstones. Claude returns a JSON list of proposed records. They are written with the reflection as their source and flagged as inferred on the Memory tab, so the owner can see what was guessed rather than told. The tombstone list is part of the prompt and is enforced on ingest, so a fact the owner has forgotten cannot be relearned from the same transcript it came from. The same job may emit at most one proactive suggestion per day to the owner's default channel, and suggestions can be turned off in config.

## Consequences

Chat latency is untouched, and a day's conversation is judged whole rather than line by line. New facts are up to a day late. Reflection quality depends on one prompt running unattended, so its proposals are marked inferred rather than trusted.

## Alternatives considered

Extract memory inline on every message. Rejected for latency, cost and premature judgement. No automatic memory at all. Rejected; a store nobody fills stays empty. Embedding search over raw transcripts. Rejected; there is no local embedding model, and transcripts cannot be selectively forgotten.
