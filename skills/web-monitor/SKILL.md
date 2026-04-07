---
name: web-monitor
description: Monitor URLs for changes, price drops, or new content
version: 1.0.0
user-invocable: true
---

# Web Monitor

Fetch the specified URL(s) and check for changes since the last check.

The user will specify what to watch for. Common use cases:
- **Price monitoring** — alert if a product price drops below a threshold
- **Content changes** — detect when a page is updated (new blog posts, docs changes)
- **Availability** — check if a product comes back in stock
- **Status pages** — monitor for outages or incidents

For each URL:
1. Fetch the current page content
2. Extract the relevant information the user asked about
3. Compare with previous results (if available from memory/filesystem)
4. Report changes or confirm "no change"

If a change is detected that matches the user's criteria, format it as an alert with:
- What changed
- Previous value vs new value
- Direct link to the page
- Recommended action
