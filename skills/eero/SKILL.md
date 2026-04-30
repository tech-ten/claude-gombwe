---
name: eero
description: Manage the home eero network — pause/unpause kid profiles, view devices, check data usage
version: 0.1.0
user-invocable: true
tools:
  - name: whoami
    type: shell
    description: Show the signed-in eero account. Fails if not logged in — prompt user to run /eero login.
    command: "node scripts/eero.mjs whoami"
  - name: networks
    type: shell
    description: List networks on the account
    command: "node scripts/eero.mjs networks"
  - name: profiles
    type: shell
    description: List profiles (one per family member) with paused state and device counts
    command: "node scripts/eero.mjs profiles"
  - name: devices
    type: shell
    description: List every device on the network with its assigned profile
    command: "node scripts/eero.mjs devices"
  - name: usage-7d
    type: shell
    description: Network-wide upload/download totals, daily series for last 7 days
    command: "node scripts/eero.mjs usage 7"
  - name: usage-30d
    type: shell
    description: Network-wide upload/download totals, daily series for last 30 days
    command: "node scripts/eero.mjs usage 30"
  - name: speedtest-history
    type: shell
    description: Recent eero internet speed-test history (down/up Mbps)
    command: "node scripts/eero.mjs speedtest"
---

# eero

Manage the home eero mesh — same backend the official phone app uses
(`api-user.e2ro.com`). Login is two-step (email/phone → SMS code → verify);
once verified, the session is reused across all calls.

## First-time setup (only needed once)

The user needs to run these manually because the SMS code lands on their phone:

```
node scripts/eero.mjs login user@example.com
# (eero SMS's a 6-digit code)
node scripts/eero.mjs verify 123456
```

After that, the session cookie is cached at `~/.claude-gombwe/data/eero-session`
and the tools above just work.

## What this skill is good for

- **Kid screen-time control** — pause a profile when a kid's overdoing it,
  unpause when homework's done. eero schedules can also be configured (bedtime
  routines), but the API surface for schedule mutation is finicky — for now
  this skill handles ad-hoc pause/unpause and tells the user to set recurring
  schedules in the app.
- **Device audit** — "what's on my network", "which device is using all the
  bandwidth this week".
- **Data usage** — daily/weekly bytes per device. Useful for spotting "the kid
  is streaming 50GB/day on this iPad".

## What this skill cannot do

- **Per-app traffic** (e.g. how much YouTube vs Netflix) — needs eero Plus and
  is exposed differently. Out of scope for v0.1.
- **Real-time throughput** (Mbps right now) — eero deliberately doesn't expose
  live DPI; the API only returns historical totals.
- **Block specific sites/categories** — needs eero Plus. Free tier can only
  pause an entire profile.

## How to invoke tools

When the user says "pause Tendai's iPad" or "is my daughter online":

1. Run `profiles` first to confirm the profile name spelling.
2. To pause: `node scripts/eero.mjs pause "Profile Name"` (run via shell, not a
   pre-defined tool — the profile name varies).
3. To unpause: `node scripts/eero.mjs unpause "Profile Name"`.
4. After mutating, run `profiles` again and confirm the new state to the user.

For "show traffic" / "who's using the most data" → `usage-7d` or `usage-30d`,
then summarise the top consumers.

## Notes

- If `whoami` fails with HTTP 401, the session expired. Tell the user to run
  the login flow again.
- All calls are read-only by default; `pause`/`unpause` are the only mutating
  commands and they're idempotent.
