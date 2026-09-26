# 5. Principals are bound by channel identity

## Status

Accepted, 2026-09-27.

## Context

An earlier audit found that every message reaching gombwe was treated as if the owner had sent it. A message from a child, one from a stranger and a dashboard request all arrived with the same authority. In a single-user tool that is harmless. In a household agent that can block devices, spend money and run scripts on the Mac, it is the central flaw.

## Decision

`data/principals.json` holds one record per person: id, name, role of owner, adult, child or guest, a list of channel bindings, and grants per connector. A binding maps a channel identity to a person: a Discord user id, a Telegram chat id, a WhatsApp phone number, a Cloudflare Access email for the dashboard and remote MCP, or a sender address for inbound mail. Every incoming message resolves to a principal before anything else happens.

An identity with no binding is a guest. Guests may chat and hold no grants. Grants are `read` or `act` per connector, the owner holds everything, and others hold nothing until the owner sets it. The per-session MCP config lists only the servers that principal may use, so a child's session never receives network, desktop, Gmail or browser tools at all.

Dashboard requests arriving without a Cloudflare Access header are treated as the owner on the home LAN. Remote access always passes through Access and always carries the header.

## Consequences

Identity is checked once, at the edge, and carried through the ledger, approvals and the dashboard sidebar. Every new channel must implement a binding. Anyone reaching the LAN directly has owner authority on the dashboard, which is accepted for a home network.

## Alternatives considered

A shared password per person. Rejected; channels already authenticate people, and a second secret would be shared and forgotten.
