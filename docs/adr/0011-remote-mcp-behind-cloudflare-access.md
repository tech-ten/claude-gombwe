# 11. The remote MCP endpoint sits behind Cloudflare Access

## Status

Accepted, 2026-09-27.

## Context

Making the Claude app the owner's mobile client means it calls gombwe from outside the house. That means a publicly reachable endpoint on a machine holding the router's credentials, the household's data and a tool that runs shell scripts. Getting this authentication wrong is worse than any other choice in this build.

A Cloudflare tunnel with Access already fronts the dashboard, so there are no open inbound ports and identity is solved.

## Decision

`src/remote-mcp.ts` serves the same tool registry over Streamable HTTP, published through the existing tunnel with Cloudflare Access in front. The gateway trusts a request only when it carries a valid Access assertion header, verified against the team's public keys, and maps that identity to a principal. Headless callers such as cloud routines use service tokens. Access is the authentication; the principal's grants and the approval classes are the authorisation, applied by the same handlers the local tools use. Every call is a ledger entry with the actor recorded as remote.

Requests arriving without the Access header can only have come from the home LAN, and are treated as the owner. Anything from outside passes through Access and always carries the header.

## Consequences

No new open port, and no credentials in the app beyond the Access session. Verification must reject an unsigned or expired assertion, because that check is the whole boundary. Remote access now depends on Cloudflare being up. Anyone on the home LAN holds owner authority, accepted for a home network.

## Alternatives considered

A bearer token in the connector config, rejected as a long lived shared secret on a phone with no revocation. A VPN only endpoint, rejected because the Claude app cannot dial a VPN.
