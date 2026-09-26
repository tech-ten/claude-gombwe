# 7. The gateway is the single writer of the new stores

## Status

Accepted, 2026-09-27.

## Context

The new subsystems each own a file under the data directory: memory, tombstones, ledger, approvals, principals, goals and monitors. More than one process can be running at once. The gateway is always on. The Claude CLI spawns a stdio MCP server per session, sometimes several. Scripts such as grocery checkout run on their own. The existing family MCP server writes its file directly, which works because it is small and rarely contended, but repeating that pattern across seven stores invites lost writes and torn JSON with no locking anywhere.

There is also a precedent in this repository: two instances fighting over the router caused the DNS and NetFlow feeds to go blind for months until a single owner was enforced.

## Decision

The gateway process is the only writer of the new stores. The stdio MCP server holds no store logic. It forwards each tool call to the gateway over the loopback interface, authenticated with a token minted for that session, which also carries the principal. Scripts do the same. Reads may go direct where they are cheap and tolerant of staleness, but every mutation goes through the one process.

## Consequences

Concurrency is solved by construction rather than by file locks. Session tokens give the gateway the caller's identity for free, which the ledger and grant checks need anyway. The gateway becomes a single point of failure for tools, and the MCP server is useless when the gateway is down. Loopback calls add a small amount of latency.

## Alternatives considered

File locks with each process writing directly. Rejected as fragile and hard to test. A queue or database. Rejected as far more machinery than a household needs.
