---
name: school-calendar-sync
description: Read iCloud Mail for this-week school events, write actionable items to the gombwe family calendar
version: 1.0.0
user-invocable: true
---

# School Calendar Sync

Scan the user's iCloud inbox (`tendai.mudavanhu@icloud.com` via Mail.app on
the Mac mini — gombwe runs there so AppleScript / `mdfind` can reach it)
for school-related emails from the past 14–30 days. Extract events that
need parental action this week or in the next two weeks. Write them to
the gombwe family events list.

## Schools to look for

Tendai's family kids attend:

- **Valkstone Primary School** — Grades 1 & 6
- **McKinnon Secondary College** — Year 8
- **Glen Eira Kindergarten / Glen Ed** — Kinder
- **St Carlo** (community / extracurricular)

Search the inbox for senders mentioning these schools, plus the platform
names below:

- **Compass** (compass.education) — Valkstone + McKinnon portal
- **Sentral**, **Xuno**, **Operoo**, **SchoolBag**, **Seesaw** — common AU
  school platforms, in case one of the schools switches
- Any `.edu.au` sender domain

Some emails will be from `noreply@compass.education` or similar — those
typically carry a one-line summary + a "view in Compass" link. The
summary line is usually enough for an event; the portal link content
isn't reachable from email alone (see "Gaps" below).

## What to INCLUDE in the calendar

Strict filter — only things requiring **explicit parental action**:

- **Payment deadlines** (camp, excursion, incursion, term fees) with
  exact due date/time
- **Consent / permission form deadlines** with exact due date/time
- **Parent-helper volunteer asks** (excursion helpers, classroom helpers,
  working bee, etc.)
- **Events the parent must attend** (interviews, performances,
  presentations, assemblies the parent is invited to)
- **Hard cutoffs for kid-facing things** the parent orders/pays for —
  e.g., **Sushi Day orders due Monday for Thursday delivery**, canteen
  pre-orders, book club orders, uniform shop appointments
- **Term dates, pupil-free days, public holidays affecting school**

## What to SKIP

Don't add these to the calendar — they're noise:

- Routine drop-off / pick-up times
- Regular timetable (Math Monday, Sport Wednesday)
- Generic newsletters with no time-sensitive ask
- "Thank you for paying" confirmations
- Account / login reminders from school platforms (e.g., Seesaw "we'll
  delete your account if you don't log in")
- Marketing / fundraiser invitations without parent action required

When in doubt: if the parent doesn't need to DO something by a date, skip it.

## Output: write to gombwe family.json

Each event is appended to `~/.claude-gombwe/data/family.json` under the
`events` array. **Always back up first** to `family.json.bak-school-<ISO-date>`.

Event schema:

```json
{
  "date": "2026-05-25",              // ISO date (YYYY-MM-DD)
  "time": "11:59",                   // optional, 24h HH:MM if specific
  "title": "Sushi orders DUE today (Valkstone Gr 1 & 6)",
  "school": "Valkstone",             // Valkstone | McKinnon | Glen Ed | St Carlo
  "child": "",                       // empty unless explicit in email — don't guess
  "type": "deadline",                // deadline | attendance | volunteer | order-cutoff
  "source": "icloud-mail",
  "source_subject": "Original email subject for traceability",
  "added_at": "2026-05-25T08:00:00Z"
}
```

After writing, verify by running:
```bash
node scripts/meals-view.mjs week
```

The Family tab UI reads from `family.json` and will surface these events
in the week grid (currently meal-focused; school items render via the
`.week-event.school` class).

## Surface the gaps

After writing, report to the user:

1. **What was added** — concise table: date · title · school
2. **What was skipped** — count of routine emails seen
3. **What couldn't be extracted** — items behind Compass / Sentral
   portals where the email only has a "view portal" link, not the actual
   date/details. Examples seen: Grade 5 Camp actual dates, Dental Van
   date, Newsletter contents, Industrial Action specifics.

For Compass gaps, suggest: *"Log into Compass and paste the dates here,
I'll add them"* — don't try to scrape the portal yourself unless
configured for it.

## Don't

- Don't touch macOS Calendar.app — write to gombwe's `family.json` only.
  User has been explicit about this.
- Don't guess which child is at which school — leave `child` empty if
  not explicit in the email.
- Don't add events older than today.
- Don't add events more than ~3 weeks out — they go stale before they
  matter; another run picks them up later when the email's still in
  the inbox.

## When the user invokes this

The user might say any of:
- "Update school calendar"
- "What's at school this week"
- "Add school stuff to family calendar"
- "/school-week"

All mean the same thing: run this skill, scan inbox, append to events[],
report back.

## Recovery

If the user disagrees with what got added, the backup
`family.json.bak-school-<ISO-date>` restores the previous state:

```bash
cp ~/.claude-gombwe/data/family.json.bak-school-<date> ~/.claude-gombwe/data/family.json
```
