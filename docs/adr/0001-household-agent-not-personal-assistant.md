# 1. Gombwe is a household agent, not a personal assistant

## Status

Accepted, 2026-09-27.

## Context

The Meta Muse and Apple announcements of September 2026 describe an assistant with memory, proactive goals, approvals, and clients on every device. Gombwe could have chased that shape directly and become a second Claude app.

The owner already has the Claude app and Claude Code. Those give personal memory, Gmail, Calendar and Drive connectors, scheduled cloud routines, browsing through Claude in Chrome, voice, and control from a phone. Rebuilding any of that inside gombwe would produce a worse copy of software that already works.

What no cloud assistant can be is the thing that lives on the home network with the household's data: the router, screen time, DNS and NetFlow history, the grocery dataset, the Mac's Mail and Calendar, and several people who are not the owner.

## Decision

Gombwe is the household agent and home host. It serves several principals (owner, partner, children, guests) with their own identities, grants and channels, and it owns the LAN and the always-on work. The Claude app is the owner's personal and mobile client, and it reaches gombwe as a connector over a remote MCP endpoint. The dashboard is the household's shared control panel and WhatsApp is the partner's channel.

## Consequences

Multi-person identity, grants and approvals become core rather than optional. Ad hoc web browsing, voice, translation and native mobile apps are deliberately out of scope. Gombwe must expose clean tools, because another client drives it.

## Alternatives considered

Build a full personal assistant with its own apps and voice. Rejected as duplicated effort against better software the owner already pays for.
