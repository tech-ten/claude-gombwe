---
name: school-calendar-sync
description: Read iCloud Mail for ALL future school events, write actionable items to gombwe family.json AND Apple Calendar Family — alarms only for events within 14 days. Portal-stub notifications (Compass/Sentral "view news item" emails with no dates in the body) get added as same-day "check portal" prompts instead of being skipped.
version: 1.3.0
user-invocable: true
---

> **Note on alarms:** school events DO get alarms (per
> `Alarm rules` below). This is the one place in the calendar
> stack where alarms are warranted — missing a payment deadline
> or skipping a parent-helper signup has actual cost. The sibling
> skill `meal-calendar-sync` deliberately has NO alarms; meals are
> visibility-only because pinging the household every dinner feels
> dictatorial and hurts adoption.

# School Calendar Sync

Scan the user's primary email inbox via Mail.app on the Mac mini
(gombwe runs there, so AppleScript / `mdfind` can read whatever mail
accounts the user has signed in). The user typically tells gombwe which
inbox to check; if not, default to whichever account they read most.
Scan emails from the past 14–30 days. Extract **every future event that
needs parental action** — whether it's tomorrow, next month, or end of
term. Write them to BOTH:

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

## Portal-stub notifications (Compass / Sentral / Audiri / Operoo)

A common pattern: the email body is just `A news item titled "<X>" has been
posted. View news item` — no date, no action detail, no deadline. The
real content is behind a portal login.

**Don't skip these.** They almost always represent a real ask (consent form,
order cutoff, payment, parent-attendance event) — they just don't surface
the date in email. Skipping them means the household misses things.

### What to do with a stub

For each portal-stub email that arrived in the last 48 hours and hasn't
already been added:

1. **Add a same-day calendar event** on the *next morning* at 8:00 AM
   (or same-day 8:00 AM if the email arrived before 8 AM) titled:
   `Check Compass: <news title>` (substitute Sentral / portal name)
2. **Description**: include the sender name, original subject line, and
   the portal URL (e.g., `valkstoneps-vic.compass.education`).
3. **Alarm**: single alarm at the event time (8:00 AM same morning) —
   this is an order-cutoff-style nudge.
4. **family.json entry**: `type: "portal-stub"`, `source_subject` set,
   `time: "08:00"`. Distinct type so dashboard can render differently.

### Stub supersession

When a later run extracts a *real* date for the same news item (either
because the user pasted detail back, or a follow-up email had body text):

1. Delete the stub event from Calendar.app (match by `Check Compass:
   <news title>` substring).
2. Replace with the proper dated event under normal alarm rules.
3. Remove the stub entry from `family.json` events; insert the real one.

### Stub fallback for older stubs

If a stub email is older than 7 days and still hasn't been superseded,
do **not** keep re-adding morning-of prompts — that becomes noise.
Instead, roll all unresolved stubs into a single weekly "Compass catch-up"
event the following Monday at 8:00 AM (one event per portal, listing
all unresolved stub titles in the description). User checks the portal
once and clears them all.

### One-off informational stubs

Some news items truly are FYI (e.g., "Lice!" notice, "Newsletter Issue
8", "Industrial Action update"). These are still added as stubs initially
because we can't tell from the subject alone — but if the user (or a
later run with body context) confirms it was FYI-only, mark the
family.json entry with `resolved: "fyi"` so future runs don't re-prompt.

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
  "type": "deadline | attendance | volunteer | order-cutoff | portal-stub",
  "source": "mail",
  "source_subject": "Original email subject",
  "added_at": "ISO timestamp when added",
  "resolved": null
}
```

`resolved` is null by default. Set to `"superseded"` when a stub is
replaced by a real dated event, or `"fyi"` when confirmed informational
(see Portal-stub notifications).

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

**Only attach alarms to events occurring within the next 14 days.**
Events further out still get written to the calendar (visibility) but
without alarms — no point pinging the household about something three
months away. When an event later enters the 14-day window, the next
run of this skill should *add* the alarm to the existing event (see
Idempotency).

For events within 14 days, by event type:

- **Payment / consent deadlines**: alarm 24h before, second alarm 2h before
- **Order cutoffs** (sushi day, canteen): alarm same morning + 2h before
- **Parent-attendance events** (assembly, interview): alarm 1h before
- **Volunteer asks** (excursion helpers): alarm 24h before
- **Whole-day events** (pupil-free, term dates): alarm 9am day-of
- **Portal stubs** (`type: portal-stub`): single alarm at event time
  (8:00 AM same morning) — see Portal-stub notifications section

**Idempotency** — before creating an event in Calendar.app, check if one
already exists for that date with the same title (or a duplicate-detection
substring). AppleScript to check:

```applescript
set existing to (every event of calendar "Family" whose summary contains "<distinctive substring>" and start date is greater than (current date))
```

If the existing event is **outside the 14-day alarm window** but the
incoming event would now be **inside** that window (the event date is
within 14 days of today), upgrade the existing event by attaching the
appropriate alarm — don't re-create. This handles "I added Grade 5 camp
2 months ago and it's now 12 days away" naturally on the next run.

If the title or date differs (e.g., school changed the date), update
the existing event in place rather than duplicating.

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
4. **Portal stubs added as "Check Compass" prompts** — list each, with
   the date the morning-of nudge was scheduled. If any stubs were rolled
   into a weekly catch-up (older than 7 days), note that too.
5. **Stubs superseded this run** — list any previously-stub events that
   got replaced with proper dated events because new info came in.

## Don't

- Don't guess which child is at which school — leave `child` empty if
  not explicit in the email
- Don't add events older than today
- Don't omit far-future events. Capture everything from the inbox; the
  alarm/no-alarm decision is what filters by recency, not the
  add/skip decision
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
