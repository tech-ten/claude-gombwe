# Changelog

All notable changes to gombwe. Versions follow semver; releases are git tags.

## [Unreleased]

### Added
- CI workflow: build and test on every push and pull request.
- Architecture decision records 0001 to 0015 under `docs/adr/`.
- Action ledger (`src/ledger.ts`): append-only JSONL of every side effect, `GET /api/ledger`.
- Principals with channel bindings and per-connector grants (`src/permissions.ts`); `/api/principals`, `/api/me`; network routes guarded and ledgered.
- `GOMBWE_CONFIG_DIR` environment override for the config directory, honoured by every module and script (used by tests and smoke runs).

### Changed
- Dashboard redesigned as an instrument panel: white surfaces, one blue accent, hairlines, system fonts, light and dark, new Home tab, grant-aware navigation (`ui/theme.css`, `docs/design-system.md`).
- Apple event packet moved to `docs/reference/apple-event/`; launcher script retired in favour of the household-agent spec and plan.
