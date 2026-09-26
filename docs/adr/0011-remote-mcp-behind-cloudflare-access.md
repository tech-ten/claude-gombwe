# 11. The remote MCP endpoint sits behind Cloudflare Access

## Status

Accepted, 2026-09-27.

## Context

Making the Claude app the owner's mobile client means the app has to call gombwe from outside the house. That requires a publicly reachable endpoint on a home machine holding the router's credentials, the household's data and a tool that runs shell scripts on the Mac. Getting the authentication wrong here is worse than any other decision in this build.

The house already runs a Cloudflare tunnel with Access in front of the dashboard, so the machine has no open inbound ports and there is an identity layer that already works.

## Decision

`src/remote-mcp.ts` serves the same tool registry over Streamable HTTP, published through the existing tunnel. Cloudflare Access sits in front. The gateway trusts a request only when it carries a valid Access assertion header, verified against the team's public keys, and maps that identity to a principal. Headless callers such as cloud routines use Access service tokens. Access is the authentication, and the principal's grants and the approval classes are the authorisation, applied by the same handlers the local tools use. Every call is a ledger entry with the actor recorded as remote.

Requests arriving without the Access header can only have come from the home LAN, and are treated as the owner. Anything from outside passes through Access and always carries the header.

## Consequences

No new open port and no credentials in the app beyond the Access session. Verification must reject an unsigned or expired assertion, since that check is the whole boundary. Gombwe now depends on Cloudflare being up for remote access. Anyone on the home LAN has owner authority, which is accepted for a home network.

## Alternatives considered

A bearer token in the connector config. Rejected; a long lived shared secret on a phone with no revocation story. A VPN only endpoint. Rejected; the Claude app cannot dial a VPN.
