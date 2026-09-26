# 4. Approvals are keyed on action classes, not per-item allowlists

## Status

Accepted, 2026-09-27.

## Context

Some actions must not happen without a human: paying for groceries, emailing someone outside the household, deleting calendar events, blocking an adult's device, running a script that changes the Mac. The usual approach is a list of permitted items, which grows on every refusal, needs hand curation nobody keeps up, and fails open for anything unlisted.

## Decision

A small policy table maps dotted action classes to `auto`, `confirm` or `never`. The classes are `pay`, `send.external`, `delete`, `network.block.adult`, `desktop.run` and `credential`, and everything else is `auto`. Credential handling is `never`: the agent does not read or enter a password, card number, CVV or one-time code. The owner can change a class on the Permissions tab, and there are no per-item lists.

The gates on the pay step, email send, adult device block and desktop run are hard: the code cannot proceed without an approval id. Requests notify the originating channel, and the owner when the requester is someone else, and expire after 30 minutes.

A caller that must block waits on the approval. The wait returns after at most 55 seconds with a pending result rather than holding a connection open. When a human decides later, the gateway injects a follow-up message into the originating chat session, so the agent resumes on its own instead of the person having to ask again.

## Consequences

New actions inherit a class and are gated on arrival, and the table is short enough to read aloud. Coarse classes sometimes ask about something harmless, which the owner fixes by reclassifying rather than by listing items.

## Alternatives considered

Per-tool allowlists. Rejected; the owner has ruled out manual curation. Blocking the caller until a decision arrives. Rejected because it ties up sessions and breaks on timeouts.
