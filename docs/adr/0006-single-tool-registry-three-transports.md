# 6. One tool registry, exposed over three transports

## Status

Accepted, 2026-09-27.

## Context

The same capabilities have to reach three callers. The gateway calls them in process for dashboard routes and chat commands. The Claude Code CLI on the mini reaches them over stdio, the way the existing family MCP server works. The Claude app on a phone and cloud routines reach them over HTTPS through the Cloudflare tunnel. Writing each surface separately would mean three copies of every schema and handler, drifting apart, with grant checks and ledger writes present in some and missing in others.

## Decision

`src/gombwe-tools.ts` is the single registry of tool schemas and handlers. It is exposed three ways without duplicating logic: in process to gateway routes, over stdio through `src/mcp/gombwe.ts` for the local Claude CLI, and over Streamable HTTP through `src/remote-mcp.ts` for the Claude app. Each transport is responsible only for framing a call and establishing the principal. The handler behind it does the grant check, the approval gate and the ledger write once, for everyone.

## Consequences

A new tool is written once and appears on all three surfaces. Security properties cannot differ per transport, which is the point. The registry is a hot spot that every task touches, so its shape has to be settled early, and handlers must not assume a transport. Tools are testable directly, without a transport at all, which is how they are tested.

## Alternatives considered

A separate MCP server per surface. Rejected as three copies of the same schemas. An internal HTTP API that all three call. Rejected because the gateway would be calling itself over the loopback interface for no gain.
