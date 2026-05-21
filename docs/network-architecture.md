# Network module — architecture

> Last reviewed: 2026-05-21. Validated with Tendai. **Read this before changing
> anything network-related.**

## Principle

**MikroTik is the network. eero is an optional sidecar that augments certain
views with AP-layer data when present.**

The codebase must reflect this:

- Default-paths assume MikroTik only.
- UI components don't have a "with eero / without eero" branch — they render
  whatever fields are on each record.
- If the eero integration is not configured, gombwe is fully functional. Wi-Fi
  panel is hidden; nothing breaks.
- "Is this an eero thing?" stops being a user-facing question.

## Why

The eeros are in bridged mode (set up tonight). MikroTik RB5009 is the router.
That means:

- eero does NOT route, do DHCP, do DNS, or enforce traffic policies.
- eero schedules, NextDNS denylist, eero pause, eero family profiles — none
  enforce anything in bridged mode. They're software facades against an
  enforcement plane that's gone.
- eero IS still authoritative for: which AP each Wi-Fi device is associated
  with, signal strength per client, mesh/backhaul health, channel utilisation,
  SSID/password/guest network admin.

So we route enforcement through MikroTik (where it actually works) and use
eero only for the Wi-Fi-layer data it uniquely provides.

## UI shape

One tab in the main dashboard, called **Network**, with the existing 10
sub-tabs preserved for muscle memory:

| Subtab | Purpose |
|---|---|
| Overview | At-a-glance status |
| Access Control | Block/allow rules, kid policies, category management |
| Devices | Every device on the LAN, table view |
| People | Owner attribution (was "Profiles") |
| Schedule | Time-window blocking |
| Usage | Per-user / per-device history + trend chart |
| Speed | WAN bandwidth + (when eero) on-demand speed test |
| Advanced | Port-forwards, DHCP reservations, firewall, NAT |
| Raw API | MikroTik query tester (+ eero secondary when configured) |
| Audit | Unified policy + manual action log |

`/ui/network.html` (the parallel page) folds into these subtabs and gets
deleted once empty.

## Per-subtab data source

| Subtab | Primary (MikroTik) | Optional eero decoration |
|---|---|---|
| **Overview** | WAN bandwidth, online device count, active blocks, today's flagged events, conntrack count | — |
| **Access Control** | Adlist (block), allowlist (bypass), category rules, kid-list, policy scanner config | — |
| **Devices** | DHCP+ARP+conntrack-driven device list, owner attribution, mDNS names, history per device | when eero present: per-device `ap` field (which AP, signal) |
| **People** | Owner heuristic + manual assignments + per-person device aggregation | — |
| **Schedule** | MikroTik-driven time windows (cron toggling block rules) | — |
| **Usage** | Per-user 30-day stacked-area trend chart, top apps, top destinations | — |
| **Speed** | WAN throughput from `mikrotik.interfaceStats()` | when eero present: speed-test panel |
| **Advanced** | Port-forwards, DHCP reservations, NAT, firewall — all MikroTik | — |
| **Raw API** | MikroTik query tester | when eero present: eero API tester |
| **Audit** | Unified log: policy actions + manual blocks + schedule firings | — |

## Code organisation (target)

```
src/network/                    ← the network module, MikroTik-default
 ├─ network-service.ts          ← facade; calls MikroTik; optionally enriches
 │                                with eero data when integrations.eero is loaded
 ├─ network-routes.ts           ← /api/network/* (everything the UI calls)
 ├─ mikrotik/
 │   ├─ client.ts
 │   ├─ snapshot-collector.ts
 │   ├─ schedule-engine.ts      ← NEW (replaces eero schedules)
 │   └─ blocklist.ts            ← NEW (adlist + allowlist wrappers)
 ├─ history/                    ← rollups + compactor
 ├─ policy/                     ← scanner, app-categories, owner-heuristic
 └─ integrations/
     └─ eero/                   ← OPTIONAL sidecar
         ├─ client.ts
         ├─ ap-enricher.ts      ← adds AP fields to device records
         └─ store.ts            ← read-only cache
```

The UI calls `/api/network/devices`. The route calls `network-service.devices()`.
That function asks MikroTik for the canonical list and, **if and only if** the
eero integration is loaded and connected, asks `ap-enricher` to add AP fields.

## Deprecation list

These endpoints stay alive temporarily (so we don't break anything mid-migration)
but the UI stops calling them. Removed in a follow-up commit once nothing
references them:

- `/api/eero/schedules` (CRUD) — replaced by MikroTik schedule engine
- `/api/eero/alerts` (CRUD) — folds into unified audit
- `/api/nextdns/denylist` (CRUD) — replaced by MikroTik adlist
- `/api/nextdns/allowlist` (CRUD) — replaced by MikroTik allowlist
- `/api/nextdns/services` (CRUD) — replaced by app-categories
- `/api/nextdns/categories` (CRUD) — replaced by app-categories
- `/api/nextdns/config` — eero NextDNS pointing is moot in bridged mode

The "Point eero at NextDNS" button is removed. MikroTik DNS hijack already
forces all clients through MikroTik DNS — eero can't bypass it.

## What stays from eero (honestly)

- **AP signal data + which AP each device is on** — MikroTik can't see this
- **Mesh / backhaul status**
- **SSID, password, guest network admin**
- **eero speed-test results** (on-demand)
- The eero JSON state files (`~/.claude-gombwe/data/eero-*`) become a
  read-only cache populated by the optional sidecar

## Execution order

Subtab by subtab. Each is committed separately so we can roll back any single
piece without affecting others.

1. **Devices** — pure data-source swap; existing UI keeps its shape
2. **Audit** — merge two logs into one unified view
3. **Access Control** — denylist/allowlist swap to MikroTik adlist
4. **Usage** — pull in the trend chart from /ui/network.html
5. **Overview** — add MikroTik vitals alongside existing eero stats
6. **Schedule** — replace backend with MikroTik schedule engine (biggest piece)
7. **People** — reconcile with owner attribution
8. **Speed / Advanced / Raw API** — tidy-up
9. **Delete `/ui/network.html` + `network.css/js`** — once nothing references them

## What we are explicitly NOT doing

- Adding new parental-control features (time budgets, coaching nudges, kid-facing
  surfaces) — those are deferred until the unification is done.
- Touching any other tab (Family, Chat, Tasks, etc.) — out of scope.
- Rearranging the subtab navigation — preserves muscle memory.
- Touching the eero JSON state files in a destructive way — they remain the cache.
- Multi-tenant or public-access architecture — that's the Channels module.

## File pointers for future edits

| Concern | File |
|---|---|
| MikroTik HTTP client | `src/mikrotik-client.ts` |
| Network service (devices, status) | `src/network-service.ts` |
| Snapshot collector (cron-like) | `src/snapshot-collector.ts` |
| DNS log receiver | `src/dns-log-receiver.ts` |
| History rollups | `src/history-rollup.ts` |
| App categories | `src/app-categories.ts` |
| Policy scanner (AI) | `src/policy-scanner.ts` |
| Owner heuristic | `src/owner-heuristic.ts` |
| mDNS listener | `src/mdns-listener.ts` |
| Log compactor | `src/log-compactor.ts` |
| eero client | `src/eero.ts` |
| eero schedules | `src/eero-schedules.ts` |
| eero store | `src/eero-store.ts` |
| eero alerts | `src/eero-alerts.ts` |
| Network UI (legacy) | `ui/network.html`, `ui/network.css`, `ui/network.js` |
| Main dashboard UI | `ui/index.html`, `ui/app.js`, `ui/style.css` |
| Gateway routes | `src/gateway.ts` (lines 1150–2100 for network/eero/nextdns) |
