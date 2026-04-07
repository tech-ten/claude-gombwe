---
name: deploy-check
description: Pre-deployment checklist — verify everything is ready to ship
version: 1.0.0
user-invocable: true
---

# Deploy Check

Run through a pre-deployment checklist for the current project:

1. **Tests** — run the test suite, report pass/fail count and any failures
2. **Build** — verify the project builds without errors or warnings
3. **Lint** — run linters if configured, report issues
4. **Dependencies** — check for outdated or vulnerable packages
5. **Environment** — verify required env vars are documented and not hardcoded
6. **Migrations** — check for pending database migrations
7. **Git status** — ensure working directory is clean, you're on the right branch
8. **Diff from main** — summarize what's actually changing in this deploy
9. **Breaking changes** — flag any API changes, config changes, or schema changes that could break things

Produce a deploy readiness report:
- GREEN: safe to deploy
- YELLOW: can deploy but review these items
- RED: do not deploy until these are fixed

Be specific about what failed and how to fix it.
