# Changelog

All notable changes to gombwe. Versions follow semver; releases are git tags.

## [Unreleased]

### Added
- CI workflow: build and test on every push and pull request.
- Architecture decision records 0001 to 0015 under `docs/adr/`.
- Action ledger (`src/ledger.ts`): append-only JSONL of every side effect, `GET /api/ledger`.
- `GOMBWE_CONFIG_DIR` environment override for the config directory (used by tests and smoke runs).

### Changed
- Apple event packet moved to `docs/reference/apple-event/`; launcher script retired in favour of the household-agent spec and plan.
