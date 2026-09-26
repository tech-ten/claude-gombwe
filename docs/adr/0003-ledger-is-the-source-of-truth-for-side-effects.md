# 3. The ledger is the source of truth for side effects

## Status

Accepted, 2026-09-27.

## Context

Before this build, gombwe recorded actions in whatever place each feature chose. The family MCP server kept an `actions` array in its own file, network policy changes went to their own JSONL, and grocery, skills, triggers and cron runs recorded nothing durable. Asking what touched the home yesterday meant reading several files with different shapes, and some answers did not exist at all.

The announcements both promise a complete audit trail. Without one, an approval system cannot be checked, a bypass cannot be detected, and nobody can tell whether the agent did what it claimed.

## Decision

One append-only file, `data/ledger.jsonl`, records every side effect, written only through `src/ledger.ts`. Each entry carries actor, principal, dotted action class, target, params, outcome, approval id, receipt, and the session, task or goal it came from. The receipt holds the durable identifiers the action produced, such as a calendar event id, a router rule id, or an order number and total. Every side-effecting path moves onto it: family tools, network controls, grocery cart and checkout, skill execution, triggers, cron, goal steps, monitor fires, and every remote MCP call. Pending approvals are ledger entries too, so a request and its outcome share a record. Files rotate at 50 MB.

## Consequences

Any action is answerable from one place, which the Activity tab reads. Soft gates become auditable, because a bypass leaves a trace even when it succeeded. Every new writer carries an obligation to record, and a missing call is now a bug.

## Alternatives considered

Per-feature logs with a query layer over them. Rejected because the shapes never converge. A database. Rejected as unneeded for append-mostly data.
