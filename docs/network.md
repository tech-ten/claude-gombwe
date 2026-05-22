# Network module — operator's reference

> Status: as-built. Last verified 2026-05-22.
> Companion to [`network-architecture.md`](./network-architecture.md), which captures the
> rationalisation plan; this doc is what's actually in the codebase.

The Network tab is the part of gombwe that turns a MikroTik RB5009 into a
parental-control router. It does five jobs:

1. **Visibility** — every device on the LAN, what they're doing, how much they're using.
2. **Network-wide blocking** — ad/malware/adult lists applied to the whole household via DNS.
3. **Per-device blocking** — kid-only category filtering at the firewall layer.
4. **Schedules** — recurring time-window blocks (bedtime) and one-off pause-untils (grounding).
5. **Audit** — every action, scheduled fire, and per-attempt block recorded in a single log.

---

## Architecture

### Physical topology

```
  Internet
     │
     ▼
  ┌──────────┐
  │ ISP modem│
  └────┬─────┘
       │  (WAN cable)
       ▼
  ┌────────────────┐   ether1 = WAN, DHCP client (gets public-ish IP from ISP)
  │  MikroTik      │   ether2-8 + sfp = bridge "bridge" (LAN)
  │  RB5009UG+S+   │   DHCP server on bridge → 192.168.88.0/24
  │  RouterOS 7.19 │   DNS server on router with adlist subscriptions
  └────┬───────────┘
       │
       │  (bridge port)
       ▼
  ┌────────────┐
  │ eero mesh  │  bridged mode — pure AP. No routing, no DHCP, no DNS.
  └────────────┘
       │ Wi-Fi
       ▼
   ┌─────────────────────────────────┐
   │ Phones / laptops / kid tablets  │
   └─────────────────────────────────┘
       │ also wired
       ▼
   ┌─────────────────┐
   │ Mac mini (gombwe host)          192.168.88.245
   │ runs: gateway, DNS log receiver, policy scanner,
   │       category enforcer, blocklist cache, etc.
   └─────────────────┘
```

### Where each capability lives

| Capability | Where it lives | Mechanism |
|---|---|---|
| Network-wide blocklists | MikroTik | `/ip/dns/adlist` subscriptions |
| Per-device category blocks | MikroTik (firewall rules) added by gombwe | `/ip/firewall/filter` `src-mac=...&dst-address=IP` |
| Recurring schedules (bedtime) | MikroTik (firewall rule with time matcher) | `/ip/firewall/filter time=21h-7h,mon,tue,...` |
| One-off pause-until | MikroTik (firewall rule + scheduler entry) | `/ip/firewall/filter` immediate + `/system/scheduler` one-shot |
| Schedule audit notifications | MikroTik scheduler → gombwe webhook | `/tool/fetch http://gombwe:18790/...` from on-event |
| AI policy scanner | gombwe (cron) | Reads DNS log → asks Claude → calls block helpers |
| DNS log capture | gombwe (UDP 1514 syslog) | RouterOS `/system/logging` → action=remote |
| Snapshot collector | gombwe (60s timer) | Pulls leases + ARP + conntrack → daily JSONL |
| History rollups | gombwe (daily) | Aggregates DNS log → per-MAC per-category bytes |

**Architectural principle:** wherever possible, enforcement lives on the router so it
survives gombwe being offline. Gombwe is needed for things that require
classification (per-DNS-query category lookup) or rich audit (timestamps,
counts, friendly names).

### DNS hijack — how every kid lookup gets observed

```
client device → router DNS (8.8.8.8 was set as the upstream)
                                              │
                                              ▼
  /ip/firewall/nat dstnat udp/53 → 192.168.88.1:53        (forces every client to MikroTik DNS)
                                              │
                                              ▼
                                  ┌───────────────────────┐
                                  │ MikroTik DNS resolver │
                                  │  • adlist lookup → NX │ ← 5b.1 enforcement
                                  │  • cache hit          │
                                  │  • resolve via 8.8.8.8│
                                  └─────┬─────────────────┘
                                        │
                  every query streamed to:
                                        │
                                        ▼
                  /system/logging action=remote → gombwe UDP 1514
                                        │
                                        ▼
                  gombwe dns-log-receiver
                       │
                       ├─ ring buffer (recent N for "what just happened" UI)
                       ├─ JSONL append (data/network/dns-YYYY-MM-DD.jsonl)
                       └─ EventEmitter "query" event → policy scanner + category enforcer
```

DoT (port 853) and DoH (provider IPs) egress are explicitly blocked so clients
can't sidestep the hijack.

---

## Per-subtab feature reference

All 10 subtabs are MikroTik-driven. Subtab IDs in DOM are `data-eero-pane="X"`
(name kept to avoid churning every call site; the eero codepath is gone).

### Overview

**Purpose:** at-a-glance router health + today's enforcement summary.

**Sections:**
- 6 stat cards: Router (model, version, uptime), Devices (online/known),
  WAN ↓/↑ Mbps, Conntrack (active flows), CPU%, Active manual blocks
- Today's enforcement: per-category counts of `blocked-by-category` actions
  + most-blocked devices today
- Top devices today: ranked by `today_bytes_down + today_bytes_up`
- Per-device blocked categories: table of every device with a non-empty
  policy showing the device, owner, category pills, today's attempt count

**Refresh:** 8s coalesce on the data-fetch (`loadOverviewData()`).

**Data sources:** `/api/network/status`, `/api/network/devices`,
`/api/network/policy/actions`.

### Access Control

**Purpose:** household-wide visibility and bulk-control surface.

**Sections:**
- **AI policy scanner** — manual "Run scan now" button + per-run summary
- **Network-wide blocklists** — toggleable category groups subscribed via
  MikroTik adlist. Custom URL add form below. See "Network-wide adlist"
  section below for the curated source list.
- **Category management** — DNS-log-driven uncategorized list with
  quick-assign UI; per-category accordion of suffix → app mappings.
  Labels-only (does not block — see "Common confusions" below).

### Devices

**Purpose:** every device on the LAN, full per-device control surface.

**Features:**
- Search + sort + filter (online/offline/blocked/paused/unknown)
- Bulk-select toolbar with bulk-block / bulk-unblock
- Click any row to drill down — shows IP/MAC/vendor/model/Bonjour services,
  today's traffic, top destinations, recent DNS queries, **and** per-device
  category-block checkboxes (5b.2 policy editor)

**Owner-attribution dropdown** + **kid-list toggle** per device.

### People (Profiles)

**Purpose:** view devices grouped by owner.

Derives from `networkState.devices` (each has an `owner` field) + the
`family.members` registry. Adding a new owner here writes to `family.members`.

### Schedule

**Purpose:** time-window per-MAC blocks, recurring or one-off.

**Two modes:**
- **Recurring** (firewall time matcher) — picks weekdays + start/end time. One
  firewall rule per schedule with `time=21h-7h,mon,tue,wed,thu,fri`.
- **Pause-until** (firewall + scheduler) — immediate block + one-shot scheduler
  entry that auto-lifts at the given datetime.

**Weekly grid:** per-device 7×24h SVG showing blocked windows. Recurring = blue
blocks, pause-until = red bars.

**Bedtime preset:** picks a kid-flagged device (or prompts) and creates a daily
21:00-07:00 schedule for it.

### Usage

**Purpose:** trend chart of category traffic over time.

Stacked-area SVG, 30-day default (configurable to 7/14/60/90), filterable to a
specific MAC. Reads from history rollups in `~/.claude-gombwe/data/network/rollups/`.

### Speed

**Purpose:** live WAN throughput + per-interface stats.

- 6 stat cards: WAN ↓/↑ Mbps, total RX/TX, interface count, errors
- Live throughput chart with 5s polling, browser-side ring buffer (~10 min
  history). Y-axis snaps to nice round values (1, 2, 5, 10, …) so the scale
  doesn't jitter. X-axis time labels at start/middle/end.
- Interfaces table: name, type, state (up/down badge), live ↓/↑ Mbps,
  cumulative RX/TX, error count (red when non-zero).

**Polling lifecycle:** auto-arms when the Speed pane activates, auto-disarms
on subtab switch — minimal router load when no one's looking.

**Live bps computation:** RouterOS `/interface` only returns cumulative byte
counters, not bits/sec. We compute deltas server-side in
`MikroTikClient.interfaceStatsLive()` using an in-memory last-sample map.
First call returns 0, subsequent calls show real rates.

### Advanced

**Purpose:** NAT, DHCP reservations, firewall viewer/cleanup.

**Port forwards:** lists `/ip/firewall/nat` where `action=dst-nat`. Add form
validates IP and port ranges. Comment prefixed `gombwe-pf` so we can identify
managed entries later.

**DHCP reservations:** all current DHCP leases, sortable. Static (reserved)
leases get a green badge, dynamic ones grey. "Reserve" button on a dynamic
lease pins its current IP for that MAC permanently.

**Firewall rules:** read-only table of all forward-chain rules. **gombwe-managed
rules** (comment starts with `gombwe`) get a blue tint and Disable/Enable +
Remove buttons. MikroTik defaults show "read-only" — server-side gate
(`/api/network/firewall/:id/toggle` and DELETE) refuses to modify them, so
even if you craft a request directly, you can't lock yourself out.

### Raw API

**Purpose:** MikroTik REST query console — debug + exploration.

- Method dropdown + path input + JSON body textarea
- 11 quick-path buttons (system/resource, interface, dhcp-server/lease,
  firewall/filter|nat|connection, dns/adlist|cache, ip/route|arp, log)
- Cmd/Ctrl+Enter in the path field sends the request
- Response: pretty-printed JSON + meta line showing `METHOD path · 14ms · 13 items`
- Backend proxy at `POST /api/network/mt-raw` — validates method and path
  shape; passes everything else through.

### Audit

**Purpose:** unified action log.

Renders from `~/.claude-gombwe/network-policy-actions.jsonl`. Shows columns:
When · Action · Device · Severity · Hostname · Detail.

**Action types:**
- `block` / `unblock` — manual device block from Devices subtab
- `blocked-by-category` — category enforcer fired (per-DNS-query) — see 5b.2 below
- `policy-changed` — per-device category policy was edited
- `schedule-block-started` / `schedule-block-ended` — schedule window opened/closed
- `policy-scan-run` — AI policy scanner tick

---

## Enforcement model

### 5b.1 — Network-wide blocklists (adlist)

**File:** `src/blocklist-sources.ts` lists curated AdBlock-format URLs from
Hagezi and OISD. Five categories (adult, gambling, dangerous, ads, social).
Each entry: id, category, label, url, description, approx_entries.

**Critical constraint:** RouterOS adlist parser only reliably handles
**AdBlock format** (`||domain^`), not hosts format (`0.0.0.0 domain`). Don't
add hosts-format URLs — they get accepted but only 2 entries load.
Verified empirically on RouterOS 7.19.6.

**Subscribe flow:**
- `POST /api/network/adlist` with `{sourceId}` or `{url, comment}`
- Refuses duplicate URLs (would just double fetch traffic)
- gombwe issues `PUT /ip/dns/adlist url=... ssl-verify=no`
- Router fetches the URL, parses, populates its DNS-blocking table
- Any subsequent DNS query for a matched hostname returns NXDOMAIN

**Limitation:** subscribing is household-wide. Adults can't carve out
exceptions for themselves. That's why per-device (5b.2) exists.

### 5b.2 — Per-device category enforcement

**Goal:** "block gambling for Liam's iPad but not mine." Can't be done at the
DNS layer with our hijack architecture (the router DNS sees the query but
can't differentiate by source MAC at DNS layer). Implemented at the firewall
layer instead.

**Components:**

**5b.2.1 — Local blocklist cache** (`src/blocklist-cache.ts`)
- Fetches the same Hagezi/OISD URLs locally (gombwe doesn't reuse the
  router's copy since router doesn't expose "is this domain in Hagezi Adult?"
  as a query)
- ~2.1M unique entries across 5 categories, ~40MB on disk
- Persisted at `~/.claude-gombwe/data/network/blocklist-cache.json`, refreshed daily
- `categoryFor(hostname)` walks parent domains (`a.b.bet365.com → b.bet365.com → bet365.com → match`)
- Used both by the enforcer AND by `app-categories.categorize()` as a fallback
  (so the Usage chart's "unknown" bucket shrinks dramatically — 5b.2.4)

**5b.2.2 — Per-device policy storage** (`network-service.ts`)
- File: `~/.claude-gombwe/network-device-policy.json`
- Schema: `{mac: {blockedCategories: ["adult","gambling"], updatedAt}}`
- Auto-seeds kid-flagged devices with `[adult, gambling, dangerous]` on
  first kid-flag toggle. Subsequent toggles don't touch the policy.
- UI: per-device checkboxes in the Devices drill-down panel
- Audit: every `setDevicePolicy` call writes a `policy-changed` audit entry

**5b.2.3 — Enforcement loop** (`src/category-enforcer.ts`)
- Subscribes to `dnsReceiver().on('query')`
- For each query: look up MAC via cached lease map (30s refresh) → check
  policy → check `categoryFor()` → if blocked, call
  `enforceCategoryBlock(mac, hostname, category, ip)`
- Enforcement = add `/ip/firewall/filter` drop rule for `src-mac × dst-ip` +
  `killConnectionsBetween(srcIp, dstIp)` to sever any in-progress flow
- **Throttled** to one action per `(mac, hostname)` per 60 seconds — kid
  retries don't flood the audit log
- **Every attempted-block writes an audit entry** with mac/hostname/category/
  ips/killed_flows — this was non-negotiable per project requirements

**Limitation flagged in `project_network_5b2_spof.md` memory:** if the Mac
mini is offline, existing drop rules persist on the router (still blocking)
but new IPs (CDN rotation, never-tried-before domains) don't get added.
5b.1 (network-wide) still covers the critical categories without gombwe.

### Schedule engine

Two distinct mechanisms, picked per use case:

**Recurring → firewall `time` matcher**
- ONE firewall rule per schedule with `time=21h-7h,mon,tue,wed,thu,fri`
- Router evaluates per-packet, so existing TCP flows get dropped at start-time
  (no conntrack-kill needed)
- Doesn't need RouterOS scheduler — survives device-mode being locked
- `.about` field on the rule reports "inactive time" when outside the window

**One-off pause-until → firewall + scheduler combo**
- Immediate block: `addMacBlock(mac, "gombwe-pause <id> active")` via `/ip/firewall/filter`
- Auto-lift: one-shot scheduler entry (interval=0s) at the pause-until datetime
  whose on-event removes both the rule AND the scheduler entry itself
- Requires `/system/scheduler` write permission — gated by device-mode

**Audit-on-fire** (recurring only — pause-until is self-evidencing)
- Each recurring schedule also creates 2 daily scheduler entries that hit a
  gombwe webhook at start and end time
- on-event: `:do {/tool/fetch url=".../api/network/schedule-fired?id=X&event=start"
  output=none keep-result=no} on-error={}`
- Gombwe webhook filters by today's day-of-week list (RouterOS scheduler
  can't natively day-filter — daily fires every day; gombwe ignores
  non-active days), then writes a `schedule-block-started` / `schedule-block-ended` audit entry
- Requires `/tool/fetch` permission (`sensitive` + `test` in user-group)

---

## Data sources and storage

### Configuration

| File | Purpose |
|---|---|
| `~/.claude-gombwe/gombwe.json` | port, host, agent config |
| `~/.claude-gombwe/mikrotik.json` | router host + REST API credentials |
| `~/.claude-gombwe/network-aliases.json` | per-MAC friendly names |
| `~/.claude-gombwe/network-owners.json` | per-MAC owner attribution |
| `~/.claude-gombwe/network-kid-list.json` | MACs flagged as kid devices |
| `~/.claude-gombwe/network-blocks.json` | currently-active manual blocks (rule IDs + expiry) |
| `~/.claude-gombwe/network-device-policy.json` | 5b.2 per-device blocked-category map |

### Runtime state

| File | Purpose |
|---|---|
| `~/.claude-gombwe/network-policy-actions.jsonl` | unified audit feed (one record per line) |
| `~/.claude-gombwe/data/network/YYYY-MM-DD.jsonl` | snapshot collector output (leases + ARP + conntrack per 60s) |
| `~/.claude-gombwe/data/network/dns-YYYY-MM-DD.jsonl` | DNS query log from receiver |
| `~/.claude-gombwe/data/network/rollups/YYYY-MM-DD.json` | per-day per-MAC per-category rollups |
| `~/.claude-gombwe/data/network/blocklist-cache.json` | 5b.2.1 local blocklist cache (~40MB) |
| `~/.claude-gombwe/data/network/schedules.json` | gombwe-side schedule definitions |
| `~/.claude-gombwe/data/app-categories.json` | user-added domain → category tags |

### Code

| File | Role |
|---|---|
| `src/mikrotik-client.ts` | typed REST client + connection state + ALL router primitives |
| `src/network-service.ts` | NetworkService singleton — devices, policy, blocks, audit writer |
| `src/blocklist-sources.ts` | curated AdBlock URLs (Hagezi/OISD) |
| `src/blocklist-cache.ts` | local fetched cache + `categoryFor()` |
| `src/category-enforcer.ts` | per-MAC per-category real-time enforcement |
| `src/schedule-service.ts` | recurring + pause-until schedule lifecycle |
| `src/policy-scanner.ts` | AI scanner (every 10min, Claude Haiku classifies kid queries) |
| `src/dns-log-receiver.ts` | UDP 1514 receiver → ring + JSONL + EventEmitter |
| `src/snapshot-collector.ts` | 60s timer pulling MikroTik state |
| `src/history-rollup.ts` | daily aggregator |
| `src/app-categories.ts` | suffix → category mapping + blocklist-cache fallback |
| `src/owner-heuristic.ts` | hostname → owner inference |
| `src/mdns-listener.ts` | passive UDP 5353 listener for Bonjour names + Apple model codes |
| `src/log-compactor.ts` | DNS log compactor (per-line → per-host rollups) |
| `src/eero-alerts.ts` | (deprecated) eero alert detectors — to be deleted in step 11 |

---

## API surface (`/api/network/*`)

### Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /status` | `{router, online_count, known_count, current_bandwidth, active_conntrack, active_blocks, data_collector}` |
| `GET /devices` | `DeviceSummary[]` — full per-device data including `blocked_categories` |
| `GET /interfaces` | live `MtInterfaceStats[]` with synthesised bits-per-second |
| `GET /dns/recent?client=IP&limit=N` | recent DNS queries from that client (ring buffer) |
| `GET /dns/summary` | per-client DNS summary |
| `GET /kid-list` | `{macs: [...]}` |
| `GET /alerts` | MikroTik-driven alerts (currently: flapping-device) |
| `GET /policy/actions` | unified audit feed (last N) |
| `GET /history?from=YYYY-MM-DD&to=...&mac=AA:BB:...&owner=Name` | history rollups for a date range |
| `GET /categories` | full category map (entries + 7d query counts per category) |
| `GET /categories/uncategorized?days=N&limit=N` | unrecognised hostnames from DNS log |
| `GET /adlist` | router subscriptions + curated source catalogue |
| `GET /nat` | all NAT rules (port forwards + masquerade etc.) |
| `GET /dhcp-leases` | all DHCP leases (static + dynamic) |
| `GET /firewall` | all forward-chain filter rules |
| `GET /schedules` | gombwe-stored schedule definitions |
| `GET /schedules/:id/inspect` | router-side state for a schedule (rules + scheduler entries + `currently_active`) |
| `GET /blocklist-cache/status` | per-category entry counts + per-source last-fetched |
| `GET /blocklist-cache/lookup?host=X` | diagnostic: what category does the cache classify this host as |
| `GET /devices/:mac/policy` | `{blockedCategories, updatedAt}` |

### Write endpoints

| Endpoint | Action |
|---|---|
| `POST /devices/:mac/block` body: `{duration?}` | manual block, optional duration in minutes |
| `POST /devices/:mac/unblock` | clear manual block |
| `POST /devices/:mac/name` body: `{name}` | set alias |
| `POST /devices/:mac/owner` body: `{owner}` | set owner attribution |
| `POST /devices/:mac/kid` body: `{enabled}` | toggle kid-list; auto-seeds 5b.2 policy when enabling |
| `PUT /devices/:mac/policy` body: `{categories: [...]}` | set per-device blocked categories |
| `POST /adlist` body: `{sourceId}` or `{url, comment}` | subscribe to a blocklist |
| `DELETE /adlist/:id` | unsubscribe |
| `POST /adlist/refresh` | force MikroTik to re-fetch all subscriptions |
| `POST /nat/port-forward` body: `{srcPort, dstAddress, dstPort, protocol, comment}` | add a dstnat rule |
| `DELETE /nat/:id` | remove a NAT rule (any) |
| `POST /dhcp-leases` body: `{mac, address, comment}` | create a static lease |
| `POST /dhcp-leases/:id/make-static` | convert dynamic lease to static |
| `DELETE /dhcp-leases/:id` | remove a lease |
| `POST /firewall/:id/toggle` body: `{disabled}` | enable/disable a gombwe-managed rule — server-side gate refuses non-gombwe rules |
| `DELETE /firewall/:id` | remove a gombwe-managed rule — same gate |
| `POST /schedules` body: see below | create a schedule (recurring or pause-until) |
| `PUT /schedules/:id` | update — tears down and re-provisions router-side |
| `DELETE /schedules/:id` | remove |
| `POST /policy/scan` | trigger an AI policy scan now |
| `POST /blocklist-cache/refresh` | force a local cache refresh |
| `POST /category-enforcer/test` body: `{mac, hostname}` | synthesize a DNS query for end-to-end testing |
| `POST /mt-raw` body: `{method, path, body}` | raw MikroTik REST proxy (used by Raw API subtab) |

### Webhook endpoints (called by the router)

| Endpoint | Trigger |
|---|---|
| `GET /schedule-fired?id=X&event=start\|end` | scheduler on-event /tool/fetch from a recurring schedule's start/end notify scheduler |

### Schedule POST body shape

**Recurring:**
```json
{
  "type": "recurring",
  "name": "Bedtime",
  "mac": "AA:BB:CC:DD:EE:FF",
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "start_time": "21:00",
  "end_time": "07:00"
}
```

**Pause-until:**
```json
{
  "type": "pause-until",
  "name": "Quick grounding",
  "mac": "AA:BB:CC:DD:EE:FF",
  "pause_until": "2026-05-22T17:00:00"
}
```

---

## MikroTik resources gombwe touches

| Resource | Operations | Used for |
|---|---|---|
| `/system/resource` | GET | Overview stats |
| `/interface` | GET | Speed subtab; status `current_bandwidth` |
| `/ip/dhcp-server/lease` | GET/PUT/POST/DELETE | Device list, static reservations |
| `/ip/arp` | (via raw) | Diagnostic |
| `/ip/firewall/filter` | GET/PUT/PATCH/DELETE + `/move` | Per-device blocks, schedules, category enforcement |
| `/ip/firewall/nat` | GET/PUT/DELETE | DNS hijack rules, port forwards |
| `/ip/firewall/connection` | GET/DELETE | conntrack inspection + targeted kill |
| `/ip/dns/adlist` | GET/PUT/DELETE | Network-wide blocklists (5b.1) |
| `/ip/dns/cache` | GET | Diagnostic via Raw API |
| `/system/scheduler` | GET/PUT/DELETE | Pause-until + audit-on-fire schedule companions |
| `/tool/fetch` | (POST from scheduler scripts only) | Webhook callbacks from on-event |
| `/system/logging` | (set up at install) | Stream DNS log to gombwe |
| `/user/group` | (read only from REST, write via SSH as admin) | Permission inspection |
| `/system/device-mode` | (read via REST, write requires physical button confirm) | Feature gating |

---

## Operations runbook

### MikroTik user setup

Gombwe authenticates as a dedicated user `gombwe` in group `gombwe-net`.

**Required policy permissions:**
```
read,write,test,sensitive,api,rest-api
```

**Denied (explicitly):**
```
!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!password,!web,!sniff,!romon
```

- `read,write,api,rest-api` — basic operation
- `sensitive` — required for `/tool/fetch` (schedule audit webhooks)
- `test` — required for tool ops
- `!policy` — gombwe cannot alter device-mode, users, or other security-critical settings
- `!reboot` — gombwe cannot reboot the router (use SSH as admin if you need to)

**Set with:**
```bash
ssh admin@192.168.88.1 \
  '/user/group/set gombwe-net policy="read,write,api,rest-api,sensitive,test"'
```

### Required device-mode flags

RouterOS 7.13+ gates dangerous features behind `device-mode`. Required for full gombwe operation:

| Flag | Default | Required | Why |
|---|---|---|---|
| `scheduler` | false | **true** | One-off pause-until schedules + audit-on-fire companions |
| `fetch` | false | **true** | Schedule audit webhooks call back via `/tool/fetch` |

**Set with** (`admin` user has the necessary `policy` permission):
```bash
ssh admin@192.168.88.1 \
  '/system/device-mode/update scheduler=yes fetch=yes'
```

The command **blocks for up to 5 minutes** waiting for a physical confirmation:
walk to the router and **briefly tap the Reset/Mode button**. The router may
reboot to apply (config is preserved). Verify after:

```
GET /system/device-mode      → scheduler: "true", fetch: "true"
```

### Required logging setup

RouterOS must be configured to stream DNS queries to gombwe at UDP 1514:

```
/system/logging/action/add name=mt-dns target=remote remote=192.168.88.245 remote-port=1514 src-address=192.168.88.1 syslog-time-format=iso prefix=mt-dns
/system/logging/add topics=dns,packet action=mt-dns
```

(This is set up by the gombwe install script; included here for reference.)

### Rebuilding and restarting

```bash
cd ~/code/claude-gombwe
npm run build       # tsc → dist/
# kill the running daemon (find PID via `ps aux | grep gombwe`)
kill <pid>
nohup gombwe start --headless > /tmp/gombwe.log 2>&1 &
```

Server binds to port 18790 by default.

### Verifying enforcement actually works

The category enforcer's wiring can be tested end-to-end without waiting for
real kid traffic:

```bash
# 1. Pick a kid MAC and set policy
curl -X PUT "http://localhost:18790/api/network/devices/<MAC>/policy" \
  -H "Content-Type: application/json" -d '{"categories":["gambling"]}'

# 2. Synthesise a DNS query for a gambling domain
curl -X POST "http://localhost:18790/api/network/category-enforcer/test" \
  -H "Content-Type: application/json" \
  -d '{"mac":"<MAC>","hostname":"bet365.com"}'
# → {"ok":true,"mac":"...","hostname":"bet365.com","category":"gambling","ips":[...],"rule_ids":["*F"],"killed":0}

# 3. Confirm the audit entry landed
curl -s "http://localhost:18790/api/network/policy/actions" | tail -3
```

### DNS resolution sanity check

To confirm the router's adlist subscriptions are actually blocking:

```bash
dig @192.168.88.1 +short doubleclick.net     # if Hagezi Pro/Multi subscribed, should be empty or 0.0.0.0
dig @192.168.88.1 +short www.0.wedding       # if Hagezi Light subscribed, should be 0.0.0.0
dig @192.168.88.1 +short example.com         # should resolve normally
```

If a blocked domain returns a real IP, the subscription is likely using
hosts-format. Switch to the adblock-format URL.

---

## Common confusions

### "I tagged a domain in Category Management — why isn't it blocked?"

Category Management is **labels only**. It tags domains so the Usage chart can
colour-code them. Network-wide blocking happens in the **Network-wide blocklists**
card above; per-device blocking happens in **Devices → drill-down → Blocked categories**.

### "I added Hagezi but the chart says only 2 entries loaded"

You subscribed to a hosts-format URL (`/hosts/...txt`). RouterOS adlist only
parses AdBlock format reliably. Switch to `/adblock/...txt`.

### "When does the Uncategorised list shrink?"

Anything in the local blocklist cache (5b.2.4 fallback) is auto-classified.
Anything outside the cache — internal services, IoT phone-home, work CDNs —
stays uncategorised. Tag them manually if you want them to show in the chart.

### "I added the gombwe user to the 'full' group — that's better, right?"

No. The `full` group includes `policy` which lets the holder alter device-mode,
user accounts, and other root-equivalent operations. Stick to the explicit
gombwe-net policy list above — least privilege.

---

## Known limitations and follow-ups

| Limitation | Workaround / status |
|---|---|
| Gombwe is a SPOF for per-device category enforcement | Existing rules persist; 5b.1 covers critical categories. Address-list refactor is the durable fix — see `project_network_5b2_spof.md` |
| Removing a category from a device's policy doesn't auto-prune existing drop rules | Manual unblock via Devices → unblock clears everything for that MAC |
| Single MAC per schedule | Bundle multiple kids onto bedtime = create one schedule per kid |
| Recurring schedules can't have day-of-week filtering at the audit-fire level | Server filters on receive; on non-active days the scheduler fires but gombwe ignores. Visible as ignored entries in `/api/network/schedule-fired` response, not stored. |
| `app-categories.json` `unknown` bucket still ~50% | Mostly legit-but-unfamiliar traffic (internal POS, IDE telemetry, etc.). Manual tag or AI-batch-classify follow-up |
| 60s dedup window in category-enforcer | Configurable in `category-enforcer.ts` if needed |

---

## Glossary

- **adlist** — MikroTik `/ip/dns/adlist` resource. A URL-backed DNS blocklist subscription.
- **address-list** — MikroTik `/ip/firewall/address-list` resource. Named list of IPs referenced from firewall rules. Distinct from adlist.
- **AdBlock format** — Filter syntax: `||domain.com^` matches domain + all subdomains.
- **conntrack** — MikroTik connection tracking table. Killing entries severs in-progress flows.
- **device-mode** — RouterOS 7.13+ security gate for risky features (scheduler, container, fetch, etc.). Requires physical button confirmation to change.
- **device policy** — Per-MAC list of blocked categories (5b.2 model).
- **DNS hijack** — Forcing all clients to use the router's DNS by NATting outbound 53/53udp to the router itself.
- **fetch** — RouterOS `/tool/fetch` command. HTTP client used by scheduler scripts for webhooks.
- **firewall time matcher** — Native `time=HH-HH,days` matcher on `/ip/firewall/filter` rules. Per-packet evaluation.
- **gombwe-net** — Dedicated MikroTik user-group with limited (but sufficient) permissions for gombwe ops.
- **kid list** — Set of MACs flagged as "kid devices". Triggers AI scanner + auto-seeds 5b.2 policy with safe defaults.
- **policy scanner** — Per-10min job that uses Claude Haiku to classify kid devices' recent DNS queries.
- **snapshot collector** — Per-60s job that captures DHCP leases + ARP + conntrack to daily JSONL.
