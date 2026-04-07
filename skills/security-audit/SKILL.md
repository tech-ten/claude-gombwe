---
name: security-audit
description: Scan code and dependencies for security vulnerabilities
version: 1.0.0
user-invocable: true
---

# Security Audit

Perform a security review of the current project:

## Dependencies
- Run `npm audit` / `pip audit` / equivalent for the project's package manager
- Flag any critical or high severity vulnerabilities
- Provide upgrade commands for each fix

## Code Scan
- Check for hardcoded secrets (API keys, passwords, tokens in source code)
- Look for SQL injection, XSS, or command injection vulnerabilities
- Check authentication and authorization patterns
- Review file upload handling if present
- Check for insecure HTTP usage where HTTPS should be used
- Look for exposed debug endpoints or verbose error messages in production config

## Configuration
- Check for overly permissive CORS settings
- Review .env.example for sensitive defaults
- Verify .gitignore covers sensitive files
- Check for exposed source maps in production builds

## Report
For each finding:
- Severity: critical / high / medium / low
- Location: file and line
- Description: what's wrong
- Fix: specific remediation steps

Summarize with a security score: A (solid), B (minor issues), C (needs attention), D/F (critical issues, fix immediately).
