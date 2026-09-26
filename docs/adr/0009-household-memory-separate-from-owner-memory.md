# 9. Household memory is separate from the owner's Claude app memory

## Status

Accepted, 2026-09-27.

## Context

The Claude app already remembers things the owner has told it, and that memory is good. Gombwe needs memory too, so the natural question is whether to treat the app's memory as the one store and avoid keeping a second one.

It cannot be the one store. A task running overnight on the mini cannot read it. A nightly reflection job cannot read it. The partner's WhatsApp session, a child's dashboard session and a goal resuming after a monitor fires cannot read it either. Everything gombwe does outside the owner's own app sessions would have no memory at all.

## Decision

Gombwe keeps its own store in `data/memory.json`, one record per fact with a subject, a kind, a source and use counters. The subject is a principal id or `household`, so the store is about the house and the people in it rather than about the owner alone. Owner-only personal preferences are not copied across; the Claude app keeps those. Forgetting writes a tombstone holding the normalised text hash, so the nightly reflection cannot relearn a fact from the same transcript it was forgotten from. A context block, capped at 2,000 characters and ordered by kind then recency, is injected into every new session and task. Records about other people appear only in household subjects and for the owner.

## Consequences

Tasks, monitors, goals and other people's sessions all have memory. Some facts will exist in both stores and can disagree, and there is no sync. Visibility rules have to be enforced in the context block, because that is the one place memory reaches a prompt.

## Alternatives considered

One shared store. Not possible; the app's memory is not readable from the host.
