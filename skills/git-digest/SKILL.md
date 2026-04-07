---
name: git-digest
description: Summarize recent git activity across your projects
version: 1.0.0
user-invocable: true
tools:
  - name: recent-commits
    description: Show recent commits across all repos in ~/code
    type: shell
    command: "find ~/code -name .git -maxdepth 2 -exec dirname {} \\; | head -10 | while read dir; do echo \"=== $(basename $dir) ===\"; git -C \"$dir\" log --oneline -3 --since='24 hours ago' 2>/dev/null; done"
  - name: uncommitted-changes
    description: Find repos with uncommitted changes
    type: shell
    command: "find ~/code -name .git -maxdepth 2 -exec dirname {} \\; | head -10 | while read dir; do cd \"$dir\" && if [ -n \"$(git status --porcelain 2>/dev/null)\" ]; then echo \"$(basename $dir): $(git status --porcelain | wc -l | tr -d ' ') changed files\"; fi; done"
  - name: branch-status
    description: Show current branch for each repo
    type: shell
    command: "find ~/code -name .git -maxdepth 2 -exec dirname {} \\; | head -10 | while read dir; do echo \"$(basename $dir): $(git -C $dir branch --show-current 2>/dev/null)\"; done"
---

# Git Digest

Run the git tools and produce a daily digest:

1. **Recent commits** — what was worked on in the last 24 hours
2. **Uncommitted changes** — repos with unsaved work (might need committing)
3. **Branch status** — which branches are checked out

Highlight anything that needs attention (uncommitted work, feature branches that have been open too long).
