# 13. No VM isolation of the Claude CLI, as an accepted risk

## Status

Accepted, 2026-09-27.

## Context

Muse's security story is a confidential virtual machine with a monitor watching the agent, and credentials the agent never sees. Gombwe runs the Claude Code CLI directly on the Mac mini with permission checks skipped, because that is what makes the host automations work. The CLI can therefore read the household's files and run any command the user account can run. A prompt injection reaching an owner session is not contained by anything.

Building real isolation would mean a virtual machine or sandboxed process for the CLI, with the data directory, the Keychain, AppleScript and the router reachable only through a mediated channel. That is a larger project than this entire build, on hardware with one mini, and it would break the desktop automations that are the reason gombwe lives on a Mac.

## Decision

Isolation is not built. The risk is accepted and mitigated by a boundary rather than a sandbox. Everything gombwe owns is reached through the tool registry, which checks grants, applies approval classes and writes the ledger. Sessions receive only the MCP servers their principal is granted, so non-owner sessions never hold desktop, network or browser tools. Secrets live in the macOS Keychain and the existing AWS profile, read at the moment of use and never placed in a prompt. Credential entry is class `never`. Hard gates on payment, external send, adult device block and desktop run cannot be bypassed in code.

## Consequences

Owner sessions keep today's power, so a successful injection in an owner session can act outside the sanctioned path. The ledger makes that visible after the fact, not before. This is recorded as a known gap.

## Alternatives considered

Run the CLI in a container or virtual machine. Rejected for effort and because it removes desktop automation. Restore permission prompts. Rejected; unattended tasks would stall.
