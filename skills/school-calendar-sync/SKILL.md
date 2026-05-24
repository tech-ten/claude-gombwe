---
name: school-calendar-sync
description: Read iCloud Mail for this-week school events, write actionable items to gombwe family.json AND Apple Calendar Family calendar with reminders
version: 1.1.0
user-invocable: true
---

# School Calendar Sync

Scan the user's primary email inbox via Mail.app on the Mac mini
(gombwe runs there, so AppleScript / `mdfind` can read whatever mail
accounts the user has signed in). The user typically tells gombwe which
inbox to check; if not, default to whichever account they read most.
Scan emails from the past 14–30 days. Extract events
that need parental action this week or in the next two weeks. Write
them to BOTH:

1. **gombwe family.json** events array (dashboard surfaces them)
2. **Apple Calendar.app → Family calendar** (wife sees them on her
   iPhone via iCloud Family Sharing, gets alarm notifications)

## How to find school senders (don't hardcode)

The user's specific schools change as kids grow. **Infer them from the
inbox; do not bake school names into this skill.**

Search recent mail for the following signals — any sender hitting one
of these is likely a school sender:

- Sender domain ends in `.edu.au`, `.school.nz`, `.edu`, or similar
  education TLDs
- Sender domain or display name contains `school`, `kinder`,
  `primary`, `secondary`, `college`, `academy`, `OSHC`
- Email mentions known AU school platforms in body or sender:
  **Compass** (`compass.education`), **Sentral**, **Xuno**, **Operoo**,
  **SchoolBag**, **Seesaw**, **Skoolbag**, **TryBooking** (excursions),
  **QKR!** (canteen / payments)
- Sender includes "noreply@" + a domain that resolves to a school

Once you've identified the school senders for THIS run, list them back
to the user in the summary so they can verify nothing was missed.

## What to INCLUDE in the calendar

Strict filter — only things requiring **explicit parental action**:

- **Payment deadlines** (camp, excursion, incursion, fees) with exact
  due date/time
- **Consent / permission form deadlines** with exact due date/time
- **Parent-helper volunteer asks** (excursion helpers, classroom helpers,
  working bee, etc.)
- **Events the parent must attend** (interviews, performances, assemblies
  the parent is invited to)
- **Hard cutoffs for kid-facing things** the parent orders/pays for —
  e.g., sushi day orders, canteen pre-orders, book club, uniform shop
  appointments
- **Term dates, pupil-free days, public holidays affecting school**

## What to SKIP

- Routine drop-off / pick-up
- Regular weekly timetable (Math Monday, Sport Wednesday)
- Generic newsletters with no time-sensitive ask
- "Thank you for paying" confirmations
- Account / login reminders from school platforms
- Marketing / fundraiser invitations without parent action

When in doubt: if the parent doesn't need to DO something by a date, skip it.

## Output 1: gombwe family.json

Append to `~/.claude-gombwe/data/family.json` `events[]` array. **Back
up first** to `family.json.bak-school-<ISO-date>`.

Event schema:

```json
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "title": "Short human description",
  "school": "Name of the school as it appears in the email",
  "child": "",
  "type": "deadline | attendance | volunteer | order-cutoff",
  "source": "mail",
  "source_subject": "Original email subject",
  "added_at": "ISO timestamp when added"
}
```

(School field is the school name the agent identified at runtime —
NOT hardcoded. Leave child empty unless the email explicitly says
which child the event is for.)

Verify with `node scripts/meals-view.mjs week`.

## Output 2: Apple Calendar.app → Family calendar

Use AppleScript via `osascript`. Pattern:

```applescript
tell application "Calendar"
  tell calendar "Family"
    set newEvent to make new event with properties {
      summary: "<event title>",
      start date: date "<localized date string>",
      end date: date "<localized date string>",
      description: "<short context — sender, action required, link>"
    }
    tell newEvent
      make new sound alarm at end with properties {trigger interval: -60}
    end tell
  end tell
end tell
```

**Alarm rules** (so wife's iPhone pings appropriately):

- **Payment / consent deadlines**: alarm 24h before, second alarm 2h before
- **Order cutoffs** (sushi day, canteen): alarm same morning + 2h before
- **Parent-attendance events** (assembly, interview): alarm 1h before
- **Volunteer asks** (excursion helpers): alarm 24h before
- **Whole-day events** (pupil-free, term dates): alarm 9am day-of

**Idempotency** — before creating an event in Calendar.app, check if one
already exists for that date with the same title (or a duplicate-detection
substring like "Sushi orders DUE"). If yes, skip; don't double-add. AppleScript
to check:

```applescript
set existing to (every event of calendar "Family" whose summary contains "<distinctive substring>" and start date is greater than (current date))
```

## Pre-requisite (one-time, not part of this skill)

For wife to get reminders on her phone, the **Family calendar in
Calendar.app must be shared with her iCloud account**. Setup once via:

Calendar.app → right-click Family → Share Calendar → invite wife's
iCloud email. Wife accepts on her device.

If the user runs this skill and the Family calendar doesn't exist or
isn't shared, surface that as a setup gap instead of writing silently.

## Surface the gaps

After writing, report to the user:

1. **Schools detected this run** (so they can confirm none missed)
2. **What was added** — table: date · title · school · also-in-Apple-Cal?
3. **What was skipped** — count of routine emails seen, with one
   example of each category skipped
4. **What couldn't be extracted** — items behind Compass / Sentral
   portals where email only has a "view portal" link. For these,
   suggest: *"Log into the portal and paste the dates, I'll add them"*

## Don't

- Don't guess which child is at which school — leave `child` empty if
  not explicit in the email
- Don't add events older than today
- Don't add events more than ~3 weeks out
- Don't write to other calendars in Calendar.app (Work, Home, etc.) —
  Family only
- Don't fail silently if Calendar.app is closed; either tell the user
  or open it via AppleScript first

## When the user invokes this

The user might say:
- "Update school calendar"
- "What's at school this week"
- "Add school stuff to family calendar"
- "/school-week"

All mean the same: scan inbox, append to events[], write to Apple
Calendar Family, report back with the schools-detected list + the
events added + the gaps.

## Recovery

If the user disagrees with what got added:

- **gombwe family.json**: restore from `family.json.bak-school-<date>`
- **Apple Calendar**: delete the offending events manually in Calendar.app,
  OR use AppleScript to bulk-delete by date range / title substring
