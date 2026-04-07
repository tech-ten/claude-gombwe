---
name: github-review
description: Review GitHub repos for issues, PRs, and action items that need attention
version: 1.0.0
user-invocable: true
---

# GitHub Review

Check the user's GitHub repositories and produce a prioritized action list:

1. **PRs awaiting your review** — list each with title, author, age, and a one-line summary of the changes
2. **Your open PRs** — check for new comments, requested changes, or merge conflicts
3. **New issues** — issues opened in the last 24 hours across your repos
4. **Failing CI** — any repos with failing checks on the default branch
5. **Stale PRs** — PRs that haven't been updated in 7+ days

For each item, recommend a specific action: review, respond, merge, close, or investigate.

End with "Start with:" followed by the single most important thing to do first.
