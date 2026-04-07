---
name: cleanup
description: Clean up and organize files, repos, or project structure
version: 1.0.0
user-invocable: true
---

# Cleanup

Analyze the specified directory (or working directory if none specified) and clean up:

## Files
- Identify and list duplicate files
- Find large files that might not belong (logs, build artifacts, node_modules in wrong places)
- Spot temporary files that should be deleted (.DS_Store, *.tmp, *.bak, thumbs.db)
- Check for files that should be in .gitignore but aren't

## Code (if it's a code project)
- Find unused dependencies in package.json / requirements.txt
- Identify dead code (unused exports, unreachable functions)
- Check for outdated dependencies with known vulnerabilities
- Find TODO/FIXME/HACK comments that have been sitting for a long time

## Git
- List branches that have been merged and can be deleted
- Find large files in git history that bloat the repo

Present findings as a checklist. Ask before deleting anything destructive.
For safe cleanups (temp files, merged branches), offer to do them automatically.
