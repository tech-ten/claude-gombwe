# 8. Deterministic monitors replace prompt polling for change detection

## Status

Accepted, 2026-09-27.

## Context

Gombwe's trigger engine could already watch for change, but it did so by asking the model. A `url_change` trigger fetched a page, handed it to Claude and asked whether anything had changed. That answer is not stable. The same page produces different verdicts on different runs, a rotating advertisement or a timestamp reads as a change, and every check costs a model call. Apple's Notify Me feature and the goals in this build both depend on the answer being right, because a goal that is waiting for a price to drop must wake exactly once, and not on a restart.

## Decision

`src/monitors.ts` does change detection deterministically. A monitor is a url, email or file target with an interval and a stored hash. For a url, the fetch uses a stable user agent, extracts the selector text or the main body, normalises whitespace, strips a list of noise patterns, and hashes the result. It fires only when the hash differs and the diff exceeds a minimum size. The last three snapshots are kept so a fire can be explained. File monitors hash content and mtime, email monitors match a query against the inbound mailbox. State persists, so a restart does not refire. A fire writes a ledger entry, notifies, and wakes the owning goal.

The trigger engine keeps `poll_prompt` for genuine judgement questions, where the model is the right tool, and `url_change` now delegates to a monitor.

## Consequences

Change detection is free, repeatable and testable with page fixtures. Noise lists and selectors need tuning per site. A meaning change that leaves the text identical is missed.

## Alternatives considered

Keep asking the model with a stricter prompt. Rejected; the failure is nondeterminism, not wording.
