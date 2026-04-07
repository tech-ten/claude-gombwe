---
name: email-digest
description: Summarize unread emails grouped by priority, flag urgent ones
version: 1.0.0
user-invocable: true
---

# Email Digest

Check the user's email inbox for unread messages. Produce a digest with:

1. **Urgent** — emails that need a response today (from known contacts, with urgent language, or time-sensitive content)
2. **Important** — emails worth reading but not urgent (newsletters from subscribed sources, updates from colleagues)
3. **Low priority** — everything else (marketing, automated notifications)

For each email include:
- Sender name
- Subject line
- One-sentence summary of the content
- Suggested action (reply, read later, archive, ignore)

For urgent emails, draft a short suggested reply.

Keep the digest concise. No more than 20 emails total. If there are more, prioritize and mention how many were skipped.
