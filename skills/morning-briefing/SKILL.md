---
name: morning-briefing
description: Daily morning briefing combining calendar, email, tasks, and news
version: 1.0.0
user-invocable: true
---

# Morning Briefing

Produce a comprehensive morning briefing. Check all connected services and compile:

## Schedule
- Today's calendar events with times, locations, and attendees
- For each meeting, add a one-line prep note (what it's about, what to bring up)

## Email
- Count of unread emails
- Top 3 most important emails that need attention today (sender, subject, one-line summary)

## Code
- Any GitHub PRs or issues that need attention
- CI/CD status of main projects

## Weather & Context
- What day of the week it is and any notable context (end of sprint, deadline approaching, etc.)

## Today's Focus
End with a recommended "top 3 priorities" list for the day based on everything above.

Keep the entire briefing under 500 words. Be concise and actionable.
