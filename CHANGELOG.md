# Changelog

All notable changes to gombwe. Versions follow semver; releases are git tags.

## [Unreleased]

### Added
- CI workflow: build and test on every push and pull request.
- Architecture decision records 0001 to 0015 under `docs/adr/`.
- Action ledger (`src/ledger.ts`): append-only JSONL of every side effect, `GET /api/ledger`.
- Grocery checkout asks for approval before placing the order; the card CVV moves to the macOS Keychain (`gombwe-grocery-cvv`); cart, checkout and order are ledgered.
- Household memory (`src/memory.ts`): durable facts per person with forget tombstones, a capped context block in every conversation and task, `/remember`, `/forget`, `/memory`, `/api/memory`.
- Approvals (`src/approvals.ts`): policy classes pay, send.external, delete, network.block.adult, desktop.run (confirm) and credential (never, locked); `/approve` and `/deny` in every chat channel; `/api/approvals`; the conversation resumes automatically after a decision.
- Principals with channel bindings and per-connector grants (`src/permissions.ts`); `/api/principals`, `/api/me`; network routes guarded and ledgered.
- `GOMBWE_CONFIG_DIR` environment override for the config directory, honoured by every module and script (used by tests and smoke runs).

### Changed
- Only loopback requests without a Cloudflare Access header count as the owner. Other LAN clients are guests until they come through dashboard.gombwe.com or are bound to a principal.
- Dashboard redesigned as an instrument panel: white surfaces, one blue accent, hairlines, system fonts, light and dark, new Home tab, grant-aware navigation (`ui/theme.css`, `docs/design-system.md`).
- Apple event packet moved to `docs/reference/apple-event/`; launcher script retired in favour of the household-agent spec and plan.
