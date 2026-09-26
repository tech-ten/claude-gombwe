# Architecture decision records

These records capture the decisions behind the household agent build, argued from the approved spec in `docs/superpowers/specs/2026-09-27-muse-parity-design.md`. Each one states the situation that forced a choice, the choice made, what it costs, and what was rejected. They are written for whoever has to change this code later and wants to know why it is shaped the way it is.

## The records

| Record | Summary |
|---|---|
| [0001](0001-household-agent-not-personal-assistant.md) | Gombwe serves the household on the home network; the Claude app stays the owner's personal client. |
| [0002](0002-claude-max-cli-only-inference.md) | All inference runs through the Claude Code CLI under Claude Max, with no paid API and no provider abstraction. |
| [0003](0003-ledger-is-the-source-of-truth-for-side-effects.md) | One append-only ledger records every side effect, written through a single module. |
| [0004](0004-approval-classes-not-allowlists.md) | Approvals are keyed on a short table of action classes rather than per-item allowlists. |
| [0005](0005-principals-bound-by-channel-identity.md) | Every message resolves to a principal through a channel binding; unbound identities are guests. |
| [0006](0006-single-tool-registry-three-transports.md) | One tool registry is exposed in process, over stdio and over HTTP, so security checks cannot differ per surface. |
| [0007](0007-gateway-single-writer-of-stores.md) | The gateway is the only writer of the new stores; other processes forward calls over loopback. |
| [0008](0008-deterministic-monitors-over-prompt-polling.md) | Change detection is hash based and repeatable, not a model judgement. |
| [0009](0009-household-memory-separate-from-owner-memory.md) | Gombwe keeps its own household memory because tasks and other people cannot read the owner's app memory. |
| [0010](0010-whatsapp-cloud-api-and-ses-inbound.md) | WhatsApp Cloud API and SES inbound mail add the partner's channel and gombwe's own address on free tiers. |
| [0011](0011-remote-mcp-behind-cloudflare-access.md) | The remote MCP endpoint authenticates with Cloudflare Access through the existing tunnel. |
| [0012](0012-dashboard-instrument-panel-design-system.md) | One instrument panel design system across every tab, mobile first, tabs gated by grants. |
| [0013](0013-no-vm-isolation-of-the-claude-cli.md) | Isolating the Claude CLI is not built; the risk is accepted and mitigated by the tool boundary. |
| [0014](0014-goals-engine-with-monitor-driven-resumption.md) | Goal steps run as ordinary tasks, wait on monitors without holding a session, and re-queue after a restart. |
| [0015](0015-nightly-reflection-proposes-memory.md) | A nightly job proposes memory records from the previous day, flagged as inferred, with tombstones blocking relearning. |

## Numbering

Records are numbered in sequence from 0001 and never renumbered. The file name is the number, then a short hyphenated slug of the decision. A number is never reused, even if a record is later superseded.

## Status

A record is `accepted` once the decision is in effect, with the date it was accepted. A record is never edited to change its decision. If a decision is replaced, add a new record and change the old one's status to `superseded by NNNN`, leaving its text alone so the history stays readable. A record that was written but never acted on is marked `rejected`.

## Adding one

Copy the section headings from any existing record: a numbered title, Status, Context, Decision, Consequences, and Alternatives considered. Aim for 150 to 300 words. Write the Context so it explains the pressure that made a decision necessary, without assuming the reader knows the discussion. Name the alternatives that were genuinely considered and say why each was rejected. Then add a row to the table above.

Write a record when a choice constrains later work, when it will be questioned, or when the obvious option was not taken. Routine implementation choices belong in the code and its comments.
