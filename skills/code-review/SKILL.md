---
name: code-review
description: Review code changes for bugs, security issues, and improvements
version: 1.0.0
user-invocable: true
---

# Code Review

Review the specified code changes (a PR, a diff, or recent commits). Analyze for:

1. **Bugs** — logic errors, off-by-one, null/undefined risks, race conditions
2. **Security** — injection vulnerabilities, exposed secrets, auth issues, OWASP top 10
3. **Performance** — unnecessary loops, N+1 queries, missing indexes, large allocations
4. **Style** — naming consistency, dead code, overly complex logic that could be simplified
5. **Missing** — error handling gaps, missing tests for new code paths, incomplete edge cases

For each finding:
- Severity: critical / warning / suggestion
- File and line reference
- What's wrong
- How to fix it (with a code snippet if helpful)

End with an overall verdict: approve, request changes, or needs discussion.

If no code is specified by the user, check for the most recent uncommitted changes in the working directory (git diff).
