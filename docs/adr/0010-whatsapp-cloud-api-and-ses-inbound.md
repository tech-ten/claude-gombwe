# 10. WhatsApp Cloud API and SES inbound mail as the new channels

## Status

Accepted, 2026-09-27.

## Context

Two gaps remain in how people reach gombwe. The partner does not use Discord or Telegram and will not start; WhatsApp is where she already is. Separately, gombwe has no address of its own, so school mail cannot be forwarded to it and a goal has no way to wait for a reply from outside the house.

WhatsApp was deprioritised earlier, on the reasoning that the dashboard covered off-LAN access. That held while the owner was the only user. It does not hold for a household agent whose second user will not open a bookmark.

## Decision

Add two channels on free or already owned infrastructure. WhatsApp uses the Meta Cloud API free tier: an inbound webhook with the signature verified against the app secret, published on a path with a Cloudflare Access bypass scoped to that path only, and outbound replies through the Graph API. Principals bind by phone number, unknown numbers get one reply saying the assistant is private and then silence, and voice notes transcribe only if a local binary exists.

Inbound mail uses AWS SES on the existing account. A receipt rule writes raw mail to S3, a poller parses it, saves attachments under the inbox directory and delivers a message bound by sender address. Outbound replies go through SES from the same address and count as external sends unless the recipient is a principal.

## Consequences

No new bills. Both channels need owner setup outside the code, which is written up in setup docs, and the code paths are tested with fixtures. The webhook path is publicly reachable, so its signature check is load bearing. SES inbound polling adds up to a minute of delay.

## Alternatives considered

WhatsApp Business through a paid provider. Rejected on cost. IMAP against an existing mailbox. Rejected; the account is not owned by gombwe.
