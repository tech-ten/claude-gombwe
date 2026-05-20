// ════════════════════════════════════════════════════════════════════
// gombwe — network (v4)
// Tailscale admin structure + editorial cream/charcoal typography.
// Table-driven layout, persistent sidebar, single floating popover.
// Vanilla ES, no build step.
// ════════════════════════════════════════════════════════════════════

const API     = "/api/network";
const WS_PATH = "/ws";

// ── tiny utilities ──────────────────────────────────────────────────

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(dp)} ${u[i]}`;
};

const fmtBytesShort = (n) => {
  if (n == null || isNaN(n)) return "0";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return `${v.toFixed(dp)} ${u[i]}`;
};

const fmtRelTime = (iso) => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10)    return "just now";
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

const humanMinutes = (m) => {
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
};

const durationToMinutes = (spec) => {
  if (spec === "0" || spec === 0) return null;          // indefinite
  if (spec === "until_tomorrow") {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    return Math.max(1, Math.round((t - Date.now()) / 60_000));
  }
  return parseInt(spec, 10);
};

// ── state ───────────────────────────────────────────────────────────

const state = {
  devices: new Map(),           // mac -> device summary
  view: "devices",              // current view
  filter: "all",                // current filter pill
  sort: { key: "last_seen", dir: "desc" },
  search: "",
  expandedDetails: new Set(),   // macs whose details row is open
  ownerOverrides: new Map(),    // mac -> person | "__household__" (localStorage fallback)
  ownerEndpointAvailable: true,
  status: null,
  pendingAssignMac: null,
  scanInFlight: false,
  cursorMac: null,              // mac currently highlighted by j/k cursor
};

const els = {
  // top strip
  crumbView:        $("#crumbView"),
  searchInput:      $("#searchInput"),
  statusDot:        $("#statusDot"),
  statusText:       $("#statusText"),
  hamburger:        $("#hamburger"),

  // sidebar
  sidebar:          $("#sidebar"),
  sidebarHost:      $("#sidebarHost"),

  // devices view
  summary:          $("#summary"),
  groups:           $("#groups"),
  emptyState:       $("#emptyState"),

  // people view
  peopleSummary:    $("#peopleSummary"),
  peopleList:       $("#peopleList"),
  peopleEmptyState: $("#peopleEmptyState"),
  unassignedHead:   $("#unassignedHead"),
  unassignedCount:  $("#unassignedCount"),
  unassignedNote:   $("#unassignedNote"),
  unassignedList:   $("#unassignedList"),
  peopleListView:   $("#peopleListView"),
  peopleDetailView: $("#peopleDetailView"),
  peopleBackBtn:    $("#peopleBackBtn"),
  detailMono:       $("#detailMono"),
  detailName:       $("#detailName"),
  detailMeta:       $("#detailMeta"),
  trendChart:       $("#trendChart"),
  trendLegend:      $("#trendLegend"),
  trendTotal:       $("#trendTotal"),
  topApps:          $("#topApps"),
  topDests:         $("#topDests"),
  detailDevices:    $("#detailDevices"),

  // activity view
  activityFeed:     $("#activityFeed"),
  activityEmpty:    $("#activityEmpty"),

  // blocks view
  blocksSummary:    $("#blocksSummary"),
  blocksList:       $("#blocksList"),
  blocksEmpty:      $("#blocksEmpty"),

  // settings view
  setHost:          $("#setHost"),
  setWs:            $("#setWs"),
  setCount:         $("#setCount"),

  // popover
  popover:          $("#popover"),
  popResume:        $("#popResume"),
  popKidToggle:     $("#popKidToggle"),

  // modal
  modalScrim:       $("#modalScrim"),
  assignModal:      $("#assignModal"),
  assignClose:      $("#assignClose"),
  assignDeviceName: $("#assignDeviceName"),
  assignOptions:    $("#assignOptions"),
  assignNewName:    $("#assignNewName"),
  assignNewBtn:     $("#assignNewBtn"),
  assignClear:      $("#assignClear"),

  // misc
  toasts:           $("#toasts"),
  deviceTpl:        $("#tpl-device-row"),
  scanNowBtn:       $("#scanNowBtn"),
  scanNowBtn2:      $("#scanNowBtn2"),

  // apps view
  appsSummary:      $("#appsSummary"),
  uncatList:        $("#uncatList"),
  uncatRange:       $("#uncatRange"),
  categoryList:     $("#categoryList"),
  catTotal:         $("#catTotal"),
};

// ── HTTP helpers ────────────────────────────────────────────────────

async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : null,
  });
  if (!r.ok) {
    const err = new Error(`${r.status} ${r.statusText}`);
    err.status = r.status;
    try { const j = await r.json(); if (j?.error) err.message = j.error; } catch {}
    throw err;
  }
  const txt = await r.text();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return {}; }
}

// ── toast ───────────────────────────────────────────────────────────

function toast(msg, kind = "ok", ms = 3000) {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 220ms";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 240);
  }, ms);
}

// ── owner heuristic (server is authoritative; fall back to name parsing) ─

const HOUSEHOLD_HINTS = [
  "tv", "printer", "router", "hub", "switch", "iot", "echo", "alexa",
  "google home", "nest", "ring", "smart", "thermostat", "doorbell",
  "camera", "speaker", "chromecast", "sonos", "hue",
  "brw", "mxchip", "esp", "shelly", "lifx", "eero",
];

// Words that look like personal names but are actually device-model labels.
// Never assign these as an owner — catches "iPhone-15", "Mac-mini", etc.
const NAME_BLACKLIST = new Set([
  "iphone","ipad","ipod","mac","macbook","imac","appletv","homepod","airpods",
  "tendais",   // hostname-derived stem — let macOS-style "tendais" still map to "Tendai" via SELFFIX below
  "samsung","galaxy","pixel","nexus","oneplus","xiaomi","redmi","huawei","honor",
  "ps5","ps4","xbox","switch","nintendo","steam","deck",
  "echo","alexa","nest","ring","hue","sonos","roku","chromecast","fire","kindle",
  "router","modem","gateway","extender","ap","access","point","tplink","netgear",
  "android","phone","tablet","laptop","desktop","pc","windows","linux",
]);

// Strip a possessive 's stem (handles macOS hostname form "tendais-…" where
// the apostrophe was lost during DHCP escaping).
function stripPossessiveStem(stem) {
  // "tendais" → "tendai"  (only if stripping leaves a sensible 3+ char name)
  if (/s$/i.test(stem) && stem.length >= 4) {
    const stripped = stem.slice(0, -1);
    if (stripped.length >= 3) return stripped;
  }
  return stem;
}

// Patterns we recognise — first capture group is always the candidate name.
// All are anchored. Apply against each candidate string in turn.
const OWNER_PATTERNS = [
  /^([A-Za-z][A-Za-z]{2,19})['’]s[\s-_]/,       // "Tendai's iPhone", "Tendai's-iPhone"
  /^([A-Za-z][A-Za-z]{2,19})[-_\s]/,            // "Tendai-iPhone", "tendais-Mac-mini"
  /[-_\s(]([A-Za-z][A-Za-z]{2,19})[)\s]*$/,     // "iPhone-Tendai", "iPad (Tendai)"
  /\bof\s+([A-Za-z][A-Za-z]{2,19})\b/i,         // "MacBook of Tendai"
];

function tryExtractOwner(s) {
  if (!s) return null;
  const raw = s.trim();
  if (!raw) return null;
  for (const re of OWNER_PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    let candidate = m[1].toLowerCase();
    candidate = stripPossessiveStem(candidate);
    if (NAME_BLACKLIST.has(candidate)) continue;
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }
  return null;
}

function guessOwner(device) {
  if (device.owner) return device.owner;
  const override = state.ownerOverrides.get(device.mac);
  if (override === "__household__") return null;
  if (override) return override;

  // Try every name source we have, most-friendly first. mDNS instance names
  // ("Tendai's iPhone") are usually richer than DHCP hostnames ("iPhone").
  const candidates = [
    device.mdns_name,
    device.name,
    device.hostname,
    device.mdns_host,
  ].filter(Boolean);

  if (candidates.length === 0) return null;

  // Household-class devices stay unassigned even if their name looks owner-y.
  for (const c of candidates) {
    const low = c.toLowerCase();
    if (HOUSEHOLD_HINTS.some(h => low.includes(h))) return null;
  }

  for (const c of candidates) {
    const owner = tryExtractOwner(c);
    if (owner) return owner;
  }
  return null;
}

// ── live indicator + summary line ───────────────────────────────────

function setLive(s) {
  els.statusDot.dataset.state = s;
  els.statusText.textContent =
    s === "live" ? "Live" : s === "connecting" ? "Connecting" : s === "error" ? "Offline" : "Idle";
}

function renderSummary() {
  const all = [...state.devices.values()];
  const online = all.filter(d => d.online).length;
  const paused = all.filter(d => d.blocked).length;
  const kids   = all.filter(d => d.kid).length;
  els.summary.innerHTML =
    `<span class="summary-num">${all.length}</span> devices` +
    `<span class="summary-sep">·</span>` +
    `<span class="summary-num">${online}</span> online` +
    `<span class="summary-sep">·</span>` +
    `<span class="summary-num">${paused}</span> paused` +
    `<span class="summary-sep">·</span>` +
    `<span class="summary-num">${kids}</span> on kid list`;

  // settings view
  if (els.setHost) els.setHost.textContent = location.host;
  if (els.setWs)   els.setWs.textContent   = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WS_PATH}`;
  if (els.setCount) els.setCount.textContent = String(all.length);

  // blocks summary
  els.blocksSummary.innerHTML =
    paused === 0
      ? `<span class="summary-num">0</span> devices paused right now`
      : `<span class="summary-num">${paused}</span> ${paused === 1 ? "device" : "devices"} paused right now`;

  // people summary
  const people = peopleByName().size;
  els.peopleSummary.innerHTML =
    `<span class="summary-num">${people}</span> ${people === 1 ? "person" : "people"} on the network`;
}

function peopleByName() {
  const byPerson = new Map();
  for (const d of state.devices.values()) {
    const owner = guessOwner(d);
    if (!owner) continue;
    if (!byPerson.has(owner)) byPerson.set(owner, []);
    byPerson.get(owner).push(d);
  }
  return byPerson;
}

// ── view switching ─────────────────────────────────────────────────

function setView(name) {
  state.view = name;
  for (const v of $$(".view")) v.hidden = v.dataset.view !== name;
  for (const n of $$(".navitem")) n.classList.toggle("is-active", n.dataset.view === name);
  els.crumbView.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === "activity") loadActivityFeed();
  if (name === "blocks")   renderBlocks();
  if (name === "people")   renderPeople();
  if (name === "devices")  renderDevices();
  if (name === "settings") renderSummary();
  if (name === "apps")     loadAppsView();
}

// ── devices: render table grouped by owner / household ──────────────

function filteredDevices() {
  const arr = [...state.devices.values()];
  return arr.filter(d => {
    if (state.filter === "online" && !d.online) return false;
    if (state.filter === "offline" && d.online) return false;
    if (state.filter === "paused" && !d.blocked) return false;
    if (state.filter === "kids" && !d.kid) return false;
    if (state.search) {
      const hay = `${d.name} ${d.hostname} ${d.ip} ${d.mac} ${d.vendor} ${guessOwner(d) || ""}`.toLowerCase();
      if (!hay.includes(state.search.toLowerCase())) return false;
    }
    return true;
  });
}

function sortDevices(arr) {
  const { key, dir } = state.sort;
  const factor = dir === "asc" ? 1 : -1;
  const get = (d) => {
    if (key === "name")      return (d.name || d.hostname || d.mac || "").toLowerCase();
    if (key === "owner")     return (guessOwner(d) || "zzz").toLowerCase();
    if (key === "activity")  return (d.today_bytes_down || 0) + (d.today_bytes_up || 0);
    if (key === "last_seen") return new Date(d.last_seen || 0).getTime();
    return 0;
  };
  return arr.sort((a, b) => {
    const A = get(a), B = get(b);
    if (A < B) return -1 * factor;
    if (A > B) return  1 * factor;
    return 0;
  });
}

function renderDevices() {
  renderSummary();

  const devices = sortDevices(filteredDevices());
  // Group by owner, household last.
  const grouped = new Map();   // person -> []
  const household = [];
  for (const d of devices) {
    const owner = guessOwner(d);
    if (!owner) household.push(d);
    else {
      if (!grouped.has(owner)) grouped.set(owner, []);
      grouped.get(owner).push(d);
    }
  }

  els.groups.innerHTML = "";

  const peopleSorted = [...grouped.keys()].sort();
  for (const person of peopleSorted) {
    appendGroup(person, grouped.get(person));
  }
  if (household.length) appendGroup("Household devices", household, true);

  els.emptyState.hidden = devices.length > 0;

  // restore details panels
  for (const mac of state.expandedDetails) {
    const row = $(`.trow[data-mac="${cssEscape(mac)}"]`);
    if (row) toggleDetails(row, true);
  }
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

function appendGroup(title, devs, isHousehold = false) {
  const hdr = document.createElement("h3");
  hdr.className = isHousehold ? "group-head group-head-household" : "group-head";
  hdr.innerHTML = `${escapeHtml(title)} <span class="group-count">${devs.length} ${devs.length === 1 ? "device" : "devices"}</span>`;
  els.groups.appendChild(hdr);

  const list = document.createElement("div");
  list.className = "trows";
  for (const d of devs) list.appendChild(buildRow(d));
  els.groups.appendChild(list);
}

function buildRow(d) {
  const frag = els.deviceTpl.content.cloneNode(true);
  const row = frag.querySelector(".trow");
  row.dataset.mac = d.mac;
  row.dataset.online = d.online ? "true" : "false";
  row.dataset.blocked = d.blocked ? "true" : "false";
  row.dataset.kid = d.kid ? "true" : "false";

  $('[data-bind="name"]',     row).textContent = d.name || d.hostname || d.mac;
  $('[data-bind="owner"]',    row).textContent = guessOwner(d) || "—";
  $('[data-bind="activity"]', row).textContent = activitySummary(d);
  $('[data-bind="seen"]',     row).textContent = fmtRelTime(d.last_seen);

  const status = $('[data-bind="statusPill"]', row);
  if (d.blocked) {
    status.textContent = "PAUSED";
    status.className = "pill-status pill-paused";
  } else if (d.online) {
    status.textContent = "ONLINE";
    status.className = "pill-status pill-online";
  } else {
    status.textContent = "OFFLINE";
    status.className = "pill-status pill-offline";
  }
  $('[data-bind="kidPill"]', row).hidden = !d.kid;
  $('[data-bind="selfPill"]', row).hidden = !d.self;

  row.addEventListener("click", onRowClick);
  row.addEventListener("keydown", onRowKey);
  return row;
}

function activitySummary(d) {
  if (d.blocked) {
    if (d.block_expires) {
      const ms = new Date(d.block_expires).getTime() - Date.now();
      if (ms > 0) return `Paused — resumes in ${humanMinutes(Math.max(1, Math.round(ms / 60_000)))}`;
    }
    return "Paused indefinitely";
  }
  const top = (d.top_destinations_today || [])[0];
  const total = (d.today_bytes_down || 0) + (d.today_bytes_up || 0);
  if (top && total > 0) return `${top.host} · ${fmtBytesShort(total)} today`;
  if (total > 0)        return `${fmtBytesShort(total)} today`;
  return d.online ? "Online — no traffic recorded yet" : "Idle";
}

// ── row interactions: click body → details; ⋯ → popover ────────────

function onRowClick(e) {
  const row = e.currentTarget;
  const mac = row.dataset.mac;
  const trigger = e.target.closest("[data-action]");
  if (trigger) {
    e.stopPropagation();
    if (trigger.dataset.action === "menu") {
      openPopoverFor(row, trigger);
    }
    return;
  }
  // clicked on the row body — expand details
  if (e.target.closest(".trow-details")) return;  // clicks inside details don't toggle
  toggleDetails(row);
}

function onRowKey(e) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleDetails(e.currentTarget);
  }
}

function toggleDetails(row, forceOpen) {
  const mac = row.dataset.mac;
  const d = state.devices.get(mac);
  if (!d) return;
  const el = $('[data-bind="details"]', row);
  const willOpen = forceOpen != null ? forceOpen : el.hidden;
  el.hidden = !willOpen;
  if (willOpen) {
    state.expandedDetails.add(mac);
    populateDetails(row, d);
  } else {
    state.expandedDetails.delete(mac);
  }
}

function populateDetails(row, d) {
  $('[data-bind="dIp"]',       row).textContent = d.ip  || "—";
  $('[data-bind="dMac"]',      row).textContent = d.mac;
  $('[data-bind="dVendor"]',   row).textContent = d.vendor || "Unknown";
  $('[data-bind="dLastSeen"]', row).textContent = fmtRelTime(d.last_seen);
  $('[data-bind="dConns"]',    row).textContent = String(d.active_connections ?? 0);
  $('[data-bind="dToday"]',    row).textContent =
    `${fmtBytes(d.today_bytes_down || 0)} down · ${fmtBytes(d.today_bytes_up || 0)} up`;

  // Model (mDNS-derived; only show if we have it)
  const modelRow = $('[data-bind="dModelRow"]', row);
  const modelText = d.model_friendly || d.model;
  if (modelText) {
    modelRow.hidden = false;
    $('[data-bind="dModel"]', row).textContent =
      d.model_friendly && d.model && d.model_friendly !== d.model
        ? `${d.model_friendly} (${d.model})`
        : modelText;
  } else {
    modelRow.hidden = true;
  }

  // Bonjour services advertised by this device
  const mdnsRow = $('[data-bind="dMdnsRow"]', row);
  if (d.mdns_services?.length) {
    mdnsRow.hidden = false;
    $('[data-bind="dMdns"]', row).textContent = d.mdns_services.slice(0, 6).join(", ");
  } else {
    mdnsRow.hidden = true;
  }

  const dests = d.top_destinations_today || [];
  $('[data-bind="destsCount"]', row).textContent = dests.length
    ? `(${dests.length} unique today)` : "";
  $('[data-bind="dests"]', row).innerHTML = dests.length
    ? dests.map(t => `<li>
        <span class="host">${escapeHtml(t.host)}</span>
        <span class="bytes">${escapeHtml(fmtBytesShort(t.bytes))}</span>
      </li>`).join("")
    : `<li><span class="host dim">No traffic recorded today</span><span></span></li>`;

  loadDnsHistory(row, d.ip).catch(err => {
    $('[data-bind="dnsList"]', row).innerHTML =
      `<li class="dns-empty">Couldn't load DNS history: ${escapeHtml(err.message)}</li>`;
  });
}

async function loadDnsHistory(row, ip) {
  if (!ip) return;
  const data = await jget(`${API}/dns/recent?client=${encodeURIComponent(ip)}&limit=500`);
  const listEl = $('[data-bind="dnsList"]', row);
  const countEl = $('[data-bind="dnsCount"]', row);
  if (!Array.isArray(data) || data.length === 0) {
    listEl.innerHTML = `<li class="dns-empty">No DNS queries yet — try again in 30s.</li>`;
    countEl.textContent = "";
    return;
  }
  const byHost = new Map();
  for (const q of data) {
    const e = byHost.get(q.hostname) ?? { count: 0, last_ts: "", blocked: false };
    e.count += 1;
    if (q.ts > e.last_ts) e.last_ts = q.ts;
    if (q.blocked) e.blocked = true;
    byHost.set(q.hostname, e);
  }
  countEl.textContent = `(${data.length} queries · ${byHost.size} unique hostnames)`;
  listEl.innerHTML = [...byHost.entries()]
    .sort((a, b) => b[1].last_ts.localeCompare(a[1].last_ts))
    .map(([host, e]) => `
      <li class="dns-row ${e.blocked ? "is-blocked" : ""}">
        <span class="dns-host">${escapeHtml(host)}</span>
        <span class="dns-meta">${escapeHtml(fmtRelTime(e.last_ts))} · ${e.count}×${e.blocked ? " · blocked" : ""}</span>
      </li>`).join("");
}

// ── popover (single shared instance, anchored at runtime) ───────────

let popoverMac = null;

function openPopoverFor(row, anchor) {
  const mac = row.dataset.mac;
  const d = state.devices.get(mac);
  if (!d) return;
  popoverMac = mac;

  els.popResume.hidden = !d.blocked;
  els.popKidToggle.textContent = d.kid ? "Remove from kid list" : "Add to kid list";

  const r = anchor.getBoundingClientRect();
  els.popover.hidden = false;
  // measure popover after un-hiding so we know its size
  const pw = els.popover.offsetWidth;
  const ph = els.popover.offsetHeight;
  let x = r.right - pw;
  let y = r.bottom + 6;
  if (x < 8) x = 8;
  if (x + pw > window.innerWidth - 8)  x = window.innerWidth - pw - 8;
  if (y + ph > window.innerHeight - 8) y = r.top - ph - 6;
  els.popover.style.left = `${x + window.scrollX}px`;
  els.popover.style.top  = `${y + window.scrollY}px`;
  anchor.setAttribute("aria-expanded", "true");
}

function closePopover() {
  els.popover.hidden = true;
  for (const t of $$('[data-action="menu"][aria-expanded="true"]')) t.setAttribute("aria-expanded", "false");
  popoverMac = null;
}

document.addEventListener("click", (e) => {
  if (els.popover.hidden) return;
  if (e.target.closest("#popover")) return;
  if (e.target.closest('[data-action="menu"]')) return;
  closePopover();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePopover();
    closeModal();
  }
});

els.popover.addEventListener("click", async (e) => {
  const item = e.target.closest(".popover-item");
  if (!item) return;
  const mac = popoverMac;
  closePopover();
  if (!mac) return;
  if (item.dataset.mins != null) {
    return blockWithDuration(mac, item.dataset.mins);
  }
  const pa = item.dataset.paction;
  if (pa === "resume")      return unblockDevice(mac);
  if (pa === "rename")      return startRename(mac);
  if (pa === "assign")      return openAssignModal(mac);
  if (pa === "toggle-kid")  return toggleKid(mac);
  if (pa === "history")     return openDeviceHistory(mac);
});

// ── block / unblock with optimistic UI + kill-active-session ────────

async function blockWithDuration(mac, spec) {
  const d = state.devices.get(mac);
  if (!d) return;
  const minutes = durationToMinutes(spec);
  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = true;
  d.block_expires = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  renderDevices();
  try {
    const res = await jpost(`${API}/devices/${encodeURIComponent(mac)}/block`,
      minutes ? { duration_minutes: minutes } : {});
    if (res?.blocked_until !== undefined) d.block_expires = res.blocked_until;
    renderDevices();
    const name = d.name || "Device";
    toast(minutes
      ? `Paused ${name} for ${humanMinutes(minutes)}${res?.killed_flows ? ` · ${res.killed_flows} active session${res.killed_flows === 1 ? "" : "s"} closed` : ""}`
      : `Paused ${name} indefinitely`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderDevices();
    toast(`Couldn't pause: ${err.message}`, "error");
  }
}

async function unblockDevice(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = false;
  d.block_expires = null;
  renderDevices();
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/unblock`);
    toast(`Resumed ${d.name || "device"}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderDevices();
    toast(`Couldn't resume: ${err.message}`, "error");
  }
}

// ── inline rename ───────────────────────────────────────────────────

async function startRename(mac) {
  const row = $(`.trow[data-mac="${cssEscape(mac)}"]`);
  if (!row) return;
  const nameEl = $('[data-bind="name"]', row);
  const original = nameEl.textContent;
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let committed = false;
  const commit = async () => {
    if (committed) return; committed = true;
    nameEl.removeAttribute("contenteditable");
    const next = nameEl.textContent.trim();
    if (next === original || !next) {
      nameEl.textContent = original;
      return;
    }
    try {
      await jpost(`${API}/devices/${encodeURIComponent(mac)}/name`, { name: next });
      const d = state.devices.get(mac);
      if (d) d.name = next;
      toast(`Renamed to ${next}`);
    } catch (err) {
      nameEl.textContent = original;
      toast(`Couldn't rename: ${err.message}`, "error");
    }
  };
  const cancel = () => {
    if (committed) return; committed = true;
    nameEl.removeAttribute("contenteditable");
    nameEl.textContent = original;
  };

  nameEl.addEventListener("blur", commit, { once: true });
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); nameEl.blur(); }
  });
}

// ── kid toggle ──────────────────────────────────────────────────────

async function toggleKid(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  const next = !d.kid;
  d.kid = next;
  renderDevices();
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/kid`, { enabled: next });
    toast(next
      ? `${d.name || "Device"} added to kid list — auto-scanner will check every 10 min`
      : `${d.name || "Device"} removed from kid list`);
  } catch (err) {
    d.kid = !next;
    renderDevices();
    toast(`Couldn't update kid list: ${err.message}`, "error");
  }
}

// ── assign-to-person modal ──────────────────────────────────────────

function openAssignModal(mac) {
  state.pendingAssignMac = mac;
  const d = state.devices.get(mac);
  els.assignDeviceName.textContent = d?.name || mac;

  // build option list = current set of people, plus a current-selection marker
  const people = [...peopleByName().keys()].sort();
  const current = guessOwner(d);
  els.assignOptions.innerHTML = people.length
    ? people.map(p => `
        <button type="button" class="assign-opt ${p === current ? "is-current" : ""}" data-person="${escapeHtml(p)}">
          <span class="assign-opt-mono">${escapeHtml(initialsFor(p))}</span>
          <span class="assign-opt-name">${escapeHtml(p)}</span>
          ${p === current ? `<span class="assign-opt-tag">current</span>` : ""}
        </button>`).join("")
    : `<p class="assign-empty">No people yet. Add one below.</p>`;
  els.assignNewName.value = "";

  // Rename the bottom button so the "remove" action is obvious. Same handler.
  els.assignClear.textContent = current ? `Unassign from ${current}` : "Move to household";

  els.modalScrim.hidden = false;
  els.assignModal.hidden = false;
  setTimeout(() => els.assignNewName.focus(), 60);
}

function closeModal() {
  els.modalScrim.hidden = true;
  els.assignModal.hidden = true;
  state.pendingAssignMac = null;
}

const initialsFor = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

// Deterministic monogram tint, stable across renders. djb2 hash mod palette.
const PERSON_TINTS = ["sage", "amber", "slate", "indigo", "plum"];
function personTint(name) {
  let h = 5381;
  const s = String(name || "").toLowerCase();
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return PERSON_TINTS[Math.abs(h) % PERSON_TINTS.length];
}

async function setOwner(mac, owner) {
  const d = state.devices.get(mac);
  if (!d) return;
  const prev = d.owner;
  d.owner = owner;
  // also update the local override map so guessOwner respects this immediately
  if (owner) state.ownerOverrides.set(mac, owner);
  else state.ownerOverrides.set(mac, "__household__");
  renderDevices();
  closeModal();
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/owner`, { owner });
    toast(owner ? `Assigned to ${owner}` : `Moved to household`);
  } catch (err) {
    d.owner = prev;
    state.ownerOverrides.delete(mac);
    renderDevices();
    toast(`Couldn't assign: ${err.message}`, "error");
  }
}

els.assignOptions.addEventListener("click", (e) => {
  const opt = e.target.closest(".assign-opt");
  if (!opt || !state.pendingAssignMac) return;
  setOwner(state.pendingAssignMac, opt.dataset.person);
});
els.assignNewBtn.addEventListener("click", () => {
  const name = els.assignNewName.value.trim();
  if (!name || !state.pendingAssignMac) return;
  setOwner(state.pendingAssignMac, name);
});
els.assignNewName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.assignNewBtn.click();
});
els.assignClose.addEventListener("click", closeModal);
els.assignClear.addEventListener("click", () => {
  if (state.pendingAssignMac) setOwner(state.pendingAssignMac, null);
});
els.modalScrim.addEventListener("click", closeModal);

// ── people view ─────────────────────────────────────────────────────

function renderPeople() {
  const byPerson = peopleByName();
  const peopleEntries = [...byPerson.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));

  // ── people list (detailed rows) ───────────────────────────────────
  if (peopleEntries.length === 0) {
    els.peopleList.innerHTML = "";
    els.peopleEmptyState.hidden = false;
  } else {
    els.peopleEmptyState.hidden = true;
    els.peopleList.innerHTML = peopleEntries.map(([name, devs]) => {
      const totalBytes = devs.reduce((s, d) => s + (d.today_bytes_down || 0) + (d.today_bytes_up || 0), 0);
      const online = devs.filter(d => d.online).length;
      const kid = devs.some(d => d.kid);
      const tint = personTint(name);
      const devNames = devs.slice(0, 3).map(d => d.name || d.hostname || d.mac).join(", ");
      const more = devs.length > 3 ? ` +${devs.length - 3}` : "";
      return `
        <div class="prow is-clickable" data-person="${escapeHtml(name)}" tabindex="0" role="button">
          <div class="prow-main">
            <div class="td td-person">
              <span class="person-mono" data-tint="${tint}">${escapeHtml(initialsFor(name))}</span>
              <span class="prow-name">${escapeHtml(name)}</span>
            </div>
            <div class="td td-pdevices">
              <span class="prow-devcount">${devs.length} ${devs.length === 1 ? "device" : "devices"}</span>
              <span class="prow-devlist">${escapeHtml(devNames)}${escapeHtml(more)}</span>
            </div>
            <div class="td td-pactivity">
              <span class="prow-bytes">${fmtBytes(totalBytes)}</span>
              <span class="prow-online">${online}/${devs.length} online</span>
            </div>
            <div class="td td-pflags">
              ${kid ? `<span class="pill-kid">KID</span>` : ""}
              <button type="button" class="prow-remove" data-prow-action="remove" data-person="${escapeHtml(name)}" title="Remove ${escapeHtml(name)} — unassigns all their devices" aria-label="Remove ${escapeHtml(name)}">×</button>
              <span class="prow-chev" aria-hidden="true">→</span>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  // ── unassigned devices ─────────────────────────────────────────────
  // Every device whose guessOwner() returns null AND isn't a household-class
  // device (TV, printer, eero, …) is a candidate for manual assignment.
  // Show these prominently so the user can attribute their iPhones/iPads.
  const unassigned = [...state.devices.values()].filter(d => {
    if (guessOwner(d)) return false;                      // already covered above
    // Hide pure household-class devices (TV, printer, eero, IoT) — they don't
    // belong to a person and would be noise here.
    const raw = (d.name || d.hostname || "").toLowerCase();
    if (HOUSEHOLD_HINTS.some(h => raw.includes(h))) return false;
    return true;
  }).sort((a, b) =>
    (b.today_bytes_down + b.today_bytes_up || 0) - (a.today_bytes_down + a.today_bytes_up || 0)
  );

  if (unassigned.length === 0) {
    els.unassignedHead.hidden = true;
    els.unassignedNote.hidden = true;
    els.unassignedList.innerHTML = "";
  } else {
    els.unassignedHead.hidden = false;
    els.unassignedNote.hidden = false;
    els.unassignedCount.textContent = `${unassigned.length} ${unassigned.length === 1 ? "device" : "devices"} · pick a person to credit their bytes`;
    els.unassignedList.innerHTML = unassigned.map(d => {
      const total = (d.today_bytes_down || 0) + (d.today_bytes_up || 0);
      const lastSeen = fmtRelTime(d.last_seen);
      return `
        <div class="prow prow-unassigned" data-mac="${escapeHtml(d.mac)}">
          <div class="prow-main">
            <div class="td td-person">
              <span class="person-mono prow-mono-mute">?</span>
              <span class="prow-name">${escapeHtml(d.name || d.hostname || d.mac)}</span>
            </div>
            <div class="td td-pdevices">
              <span class="prow-devlist">${escapeHtml(d.vendor || "Unknown")} · ${escapeHtml(d.ip || "—")}</span>
            </div>
            <div class="td td-pactivity">
              <span class="prow-bytes">${fmtBytes(total)}</span>
              <span class="prow-online">${escapeHtml(lastSeen)}</span>
            </div>
            <div class="td td-pflags">
              <button type="button" class="btn-inline" data-unassigned-action="assign" data-mac="${escapeHtml(d.mac)}">Assign…</button>
            </div>
          </div>
        </div>`;
    }).join("");
  }
}

// Click delegation for the unassigned list — opens the assign-to-person modal.
document.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-unassigned-action="assign"]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const mac = btn.dataset.mac;
  if (mac) openAssignModal(mac);
});

// Remove-person affordance — unassigns every device owned by this person.
// The person entry vanishes from the list automatically (it's derived).
document.addEventListener("click", async (e) => {
  const btn = e.target.closest('[data-prow-action="remove"]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const person = btn.dataset.person;
  if (!person) return;
  const devs = [...state.devices.values()].filter(d => guessOwner(d) === person);
  if (devs.length === 0) {
    // nothing to unassign — just optimistically remove from any UI state
    renderPeople();
    return;
  }
  const ok = confirm(
    `Remove "${person}"?\n\nThis will unassign ${devs.length} device${devs.length === 1 ? "" : "s"} (${devs.slice(0, 4).map(d => d.name || d.mac).join(", ")}${devs.length > 4 ? ", …" : ""}). The devices stay on the network — only the person assignment is cleared.`
  );
  if (!ok) return;
  for (const d of devs) {
    try {
      await jpost(`${API}/devices/${encodeURIComponent(d.mac)}/owner`, { owner: null });
      d.owner = null;
      state.ownerOverrides.set(d.mac, "__household__");
    } catch (err) {
      toast(`Couldn't unassign ${d.name || d.mac}: ${err.message}`, "error");
    }
  }
  toast(`Removed "${person}" — ${devs.length} device${devs.length === 1 ? "" : "s"} unassigned`);
  renderPeople();
  if (state.view === "devices") renderDevices();
});

// ── person history detail (long-term browsing trend) ────────────────

// Categorical palette for stacked area + legend swatches. Each hue is
// distinguishable from its neighbours at chart density. We deliberately
// reserve grey for the "noise" categories (system, ads, unknown) and
// alarm-red for adult — that way colour itself carries semantic meaning,
// not just visual variety.
const CATEGORY_COLORS = {
  video:        "#1F6E8C",   // deep teal
  social:       "#E15A2A",   // orange-red — the loud one, social is usually big
  messaging:    "#3B5BB6",   // royal blue
  gaming:       "#2E7D32",   // forest green
  music:        "#C7A24A",   // mustard
  productivity: "#506A8A",   // slate blue
  shopping:     "#B8467A",   // magenta
  news:         "#8B5E3C",   // warm brown
  system:       "#B5B5B5",   // muted grey — background noise, deliberate
  ads:          "#8E8E8E",   // mid grey — also noise
  adult:        "#C13030",   // alarm red
  gambling:     "#E08B2A",   // warning amber
  dangerous:    "#7A1F1F",   // dark blood red — stronger than adult, visually owns the band
  unknown:      "#D6D6D6",   // light grey — uncategorised
};
const CATEGORY_ORDER = [
  "video","social","messaging","gaming","music",
  "productivity","shopping","news","system","ads",
  "adult","gambling","dangerous","unknown",
];

// detailState.subject: { kind: "person", name }  OR  { kind: "device", mac, name }
const detailState = { subject: null, days: 30, payload: null };

function openPeopleDetail(name) {
  openHistoryDetail({ kind: "person", name });
}

function openDeviceHistory(mac) {
  const d = state.devices.get(mac);
  const name = d?.name || d?.hostname || mac;
  openHistoryDetail({ kind: "device", mac, name });
}

function openHistoryDetail(subject) {
  detailState.subject = subject;
  state.view = "people";
  // Push the user to the People view so the detail panel is visible.
  for (const v of $$(".view")) v.hidden = v.dataset.view !== "people";
  for (const n of $$(".navitem")) n.classList.toggle("is-active", n.dataset.view === "people");
  els.crumbView.textContent = "Users";
  els.peopleListView.hidden = true;
  els.peopleDetailView.hidden = false;

  const tint = subject.kind === "person" ? personTint(subject.name) : "slate";
  els.detailMono.setAttribute("data-tint", tint);
  els.detailMono.textContent = subject.kind === "person" ? initialsFor(subject.name) : "▣";
  els.detailName.textContent = subject.name;
  els.detailMeta.textContent = "Loading history…";
  els.trendChart.innerHTML = "";
  els.trendLegend.innerHTML = "";
  els.topApps.innerHTML = "";
  els.topDests.innerHTML = "";
  els.detailDevices.innerHTML = "";

  loadDetailHistory(subject, detailState.days);
}

function closePeopleDetail() {
  const cameFromDevice = detailState.subject?.kind === "device";
  detailState.subject = null;
  detailState.payload = null;
  els.peopleDetailView.hidden = true;
  els.peopleListView.hidden = false;
  // If the user opened this detail panel from a device row, send them back
  // to the Devices view (where they came from). Otherwise stay in People.
  if (cameFromDevice) setView("devices");
}

async function loadDetailHistory(subject, days) {
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - (days - 1) * 86_400_000);
  const from = fromDate.toISOString().slice(0, 10);
  const filter = subject.kind === "person"
    ? `owner=${encodeURIComponent(subject.name)}`
    : `mac=${encodeURIComponent(subject.mac)}`;
  try {
    const payload = await jget(`${API}/history?${filter}&from=${from}&to=${to}`);
    detailState.payload = payload;
    renderPersonDetail(payload);
  } catch (err) {
    els.detailMeta.textContent = `Couldn't load history: ${err.message}`;
  }
}

function renderPersonDetail(payload) {
  const days = payload.days || [];
  const totalBytes   = days.reduce((s, d) => s + (d.total_bytes || 0),   0);
  const totalQueries = days.reduce((s, d) => s + (d.total_queries || 0), 0);
  const totalHours   = days.reduce((s, d) =>
    s + d.devices.reduce((ss, dev) => ss + (dev.hours_active || 0), 0), 0);

  const subject = detailState.subject;
  if (subject?.kind === "device") {
    const d = state.devices.get(subject.mac);
    const vendor = d?.vendor || "Unknown vendor";
    const ip = d?.ip || "—";
    els.detailMeta.textContent =
      `${vendor} · ${ip} · ${days.length} days · ${fmtBytes(totalBytes)} · ${totalQueries.toLocaleString()} DNS queries`;
  } else {
    els.detailMeta.textContent =
      `${days.length} days · ${fmtBytes(totalBytes)} total · ${totalQueries.toLocaleString()} DNS queries · ${totalHours.toFixed(1)} device-hours`;
  }
  els.trendTotal.textContent = fmtBytes(totalBytes);

  drawStackedAreaChart(days);
  drawLegend();
  renderTopApps(days);
  renderTopDests(days);
  // "Devices" section is for owners (multiple devices). For a single-device view
  // it'd just echo the page header — hide it.
  const devSection = els.detailDevices.closest(".detail-section");
  if (devSection) devSection.hidden = subject?.kind === "device";
  if (subject?.kind !== "device") renderDetailDevices(days);
}

function categoryTotalsForDay(day) {
  // Sum each device's categories map into a single per-day totals object.
  const out = {};
  for (const dev of day.devices || []) {
    const cats = dev.categories || {};
    for (const k of Object.keys(cats)) out[k] = (out[k] || 0) + cats[k];
  }
  return out;
}

function drawStackedAreaChart(days) {
  const svg = els.trendChart;
  svg.innerHTML = "";
  if (days.length === 0) return;

  // Layout
  const W = 800, H = 240, padL = 44, padR = 8, padT = 12, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = days.length;

  // Compute per-day stacks (category → bytes), and find max total.
  const stacks = days.map(categoryTotalsForDay);
  let maxTotal = 0;
  for (const s of stacks) {
    let t = 0;
    for (const k of Object.keys(s)) t += s[k];
    if (t > maxTotal) maxTotal = t;
  }
  if (maxTotal === 0) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", W / 2);
    text.setAttribute("y", H / 2);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "chart-empty-text");
    text.textContent = "No traffic recorded in this range";
    svg.appendChild(text);
    return;
  }

  const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxTotal) * plotH;

  // Build per-category cumulative bands
  const ns = "http://www.w3.org/2000/svg";

  // Horizontal gridlines (4 ticks)
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
    line.setAttribute("y1", y);    line.setAttribute("y2", y);
    line.setAttribute("class", "chart-gridline");
    svg.appendChild(line);
    const val = maxTotal * (1 - g / 4);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", padL - 6); label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = fmtBytesShort(val);
    svg.appendChild(label);
  }

  // Stack: bottom-up in CATEGORY_ORDER (so important categories sit on top)
  const stackedBottom = new Array(n).fill(0);
  // Walk from least- to most-prominent so important sits on top.
  for (let ci = CATEGORY_ORDER.length - 1; ci >= 0; ci--) {
    const cat = CATEGORY_ORDER[ci];
    const colour = CATEGORY_COLORS[cat] || "#CCC";
    let hasAny = false;
    let pathTop = "";
    let pathBot = "";
    for (let i = 0; i < n; i++) {
      const v = stacks[i][cat] || 0;
      if (v > 0) hasAny = true;
      const yTop = yAt(stackedBottom[i] + v);
      const yBot = yAt(stackedBottom[i]);
      pathTop += `${i === 0 ? "M" : "L"} ${xAt(i)} ${yTop} `;
      pathBot = `L ${xAt(i)} ${yBot} ` + pathBot;
    }
    if (!hasAny) continue;
    const d = pathTop + pathBot + "Z";
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", colour);
    p.setAttribute("fill-opacity", "0.85");
    p.setAttribute("class", "chart-band");
    p.setAttribute("data-category", cat);
    svg.appendChild(p);
    for (let i = 0; i < n; i++) stackedBottom[i] += stacks[i][cat] || 0;
  }

  // X-axis date labels (first, middle, last)
  const labelIdx = n <= 3 ? days.map((_, i) => i) : [0, Math.floor(n / 2), n - 1];
  for (const i of labelIdx) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", xAt(i));
    text.setAttribute("y", H - 8);
    text.setAttribute("text-anchor", i === 0 ? "start" : i === n - 1 ? "end" : "middle");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = formatChartDate(days[i].date);
    svg.appendChild(text);
  }
}

function formatChartDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function drawLegend() {
  // Show only categories that actually appear in the data
  const seen = new Set();
  for (const day of (detailState.payload?.days || [])) {
    const totals = categoryTotalsForDay(day);
    for (const k of Object.keys(totals)) if (totals[k] > 0) seen.add(k);
  }
  els.trendLegend.innerHTML = CATEGORY_ORDER
    .filter(c => seen.has(c))
    .map(c => `<span class="legend-item"><span class="legend-swatch" style="background:${CATEGORY_COLORS[c]}"></span>${c}</span>`)
    .join("");
}

function renderTopApps(days) {
  const totals = new Map();   // app → { bytes, queries, category }
  for (const day of days) {
    for (const dev of day.devices || []) {
      for (const app of dev.apps || []) {
        const cur = totals.get(app.app) || { bytes: 0, queries: 0, category: app.category };
        cur.bytes   += app.bytes   || 0;
        cur.queries += app.queries || 0;
        totals.set(app.app, cur);
      }
    }
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => (b[1].bytes + b[1].queries * 50) - (a[1].bytes + a[1].queries * 50))
    .slice(0, 12);
  if (ranked.length === 0) {
    els.topApps.innerHTML = `<li class="rank-empty">No app activity in this range.</li>`;
    return;
  }
  els.topApps.innerHTML = ranked.map(([app, v]) => `
    <li class="rank-row">
      <span class="rank-cat" style="background:${CATEGORY_COLORS[v.category] || '#ccc'}"></span>
      <span class="rank-name">${escapeHtml(app)}</span>
      <span class="rank-bytes">${fmtBytes(v.bytes)}</span>
      <span class="rank-meta">${v.queries.toLocaleString()} queries</span>
    </li>`).join("");
}

function renderTopDests(days) {
  const totals = new Map();
  for (const day of days) {
    for (const dev of day.devices || []) {
      for (const t of dev.top_destinations || []) {
        const cur = totals.get(t.host) || { bytes: 0, queries: 0 };
        cur.bytes   += t.bytes   || 0;
        cur.queries += t.queries || 0;
        totals.set(t.host, cur);
      }
    }
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 12);
  if (ranked.length === 0) {
    els.topDests.innerHTML = `<li class="rank-empty">No destinations recorded.</li>`;
    return;
  }
  els.topDests.innerHTML = ranked.map(([host, v]) => `
    <li class="rank-row">
      <span class="rank-name">${escapeHtml(host)}</span>
      <span class="rank-bytes">${fmtBytes(v.bytes)}</span>
      <span class="rank-meta">${v.queries.toLocaleString()} queries</span>
    </li>`).join("");
}

function renderDetailDevices(days) {
  // Sum bytes per device-MAC across the range.
  const totals = new Map();   // mac → { name, bytes_up, bytes_down, hours }
  for (const day of days) {
    for (const dev of day.devices || []) {
      const cur = totals.get(dev.mac) || { name: dev.name || dev.mac, bytes_up: 0, bytes_down: 0, hours: 0 };
      cur.bytes_up   += dev.bytes_up   || 0;
      cur.bytes_down += dev.bytes_down || 0;
      cur.hours      += dev.hours_active || 0;
      cur.name       = dev.name || cur.name;
      totals.set(dev.mac, cur);
    }
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => (b[1].bytes_up + b[1].bytes_down) - (a[1].bytes_up + a[1].bytes_down));
  if (ranked.length === 0) {
    els.detailDevices.innerHTML = `<li class="rank-empty">No devices recorded for this user.</li>`;
    return;
  }
  els.detailDevices.innerHTML = ranked.map(([mac, v]) => `
    <li class="rank-row">
      <span class="rank-name">${escapeHtml(v.name)}</span>
      <span class="rank-bytes">${fmtBytes(v.bytes_up + v.bytes_down)}</span>
      <span class="rank-meta">${v.hours.toFixed(1)} h active</span>
    </li>`).join("");
}

// People-row click handler (drill into per-person history)
document.addEventListener("click", (e) => {
  const row = e.target.closest(".prow.is-clickable");
  if (!row) return;
  if (e.target.closest("button")) return;  // assign / inline actions don't drill
  const name = row.dataset.person;
  if (name) openPeopleDetail(name);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".prow.is-clickable");
  if (!row) return;
  e.preventDefault();
  openPeopleDetail(row.dataset.person);
});

// ── blocks view ─────────────────────────────────────────────────────

function renderBlocks() {
  renderSummary();
  const paused = [...state.devices.values()].filter(d => d.blocked);
  els.blocksList.innerHTML = "";
  if (paused.length === 0) {
    els.blocksEmpty.hidden = false;
    return;
  }
  els.blocksEmpty.hidden = true;
  const list = document.createElement("div");
  list.className = "trows";
  for (const d of paused) list.appendChild(buildRow(d));
  els.blocksList.appendChild(list);
}

// ── apps view (category database) ───────────────────────────────────

const appsState = { categories: null, uncategorized: null };

async function loadAppsView() {
  els.appsSummary.textContent = "Loading…";
  els.categoryList.innerHTML = "";
  els.uncatList.innerHTML = `<li class="rank-empty">Loading…</li>`;
  try {
    const [cats, uncat] = await Promise.all([
      jget(`${API}/categories`),
      jget(`${API}/categories/uncategorized?days=7&limit=40`),
    ]);
    appsState.categories = cats;
    appsState.uncategorized = uncat;
    renderAppsView();
  } catch (err) {
    els.appsSummary.textContent = `Couldn't load categories: ${err.message}`;
  }
}

function renderAppsView() {
  const cats = appsState.categories;
  const uncat = appsState.uncategorized;
  if (!cats) return;

  // ── summary line ─────────────────────────────────────────────────
  const totalEntries = Object.values(cats.categories).reduce((s, c) => s + c.entries.length, 0);
  const userEntries  = Object.values(cats.categories)
    .reduce((s, c) => s + c.entries.filter(e => e.source === "user").length, 0);
  const activeCats = Object.values(cats.categories).filter(c => c.count_recent_7d > 0).length;
  els.appsSummary.innerHTML =
    `<span class="summary-num">${totalEntries}</span> known suffixes across <span class="summary-num">${Object.keys(cats.categories).length}</span> categories · ` +
    `<span class="summary-num">${userEntries}</span> your overrides · ` +
    `<span class="summary-num">${activeCats}</span> active this week`;
  els.catTotal.textContent = `${totalEntries} entries`;

  // ── uncategorized list with quick-assign ─────────────────────────
  const items = uncat?.items || [];
  els.uncatRange.textContent = `last ${uncat?.days ?? 7} days · ${items.length} hostnames`;
  if (items.length === 0) {
    els.uncatList.innerHTML = `<li class="rank-empty">No uncategorized destinations in the last week.</li>`;
  } else {
    els.uncatList.innerHTML = items.map(it => `
      <li class="rank-row uncat-row" data-hostname="${escapeHtml(it.hostname)}">
        <span class="rank-name">${escapeHtml(it.hostname)}</span>
        <span class="rank-bytes">${it.count.toLocaleString()}</span>
        <span class="rank-meta">${escapeHtml(fmtRelTime(it.last_seen))}${it.blocked ? ` · ${it.blocked} blocked` : ""}</span>
        <span class="uncat-actions">
          <input type="text" class="uncat-app" placeholder="App name" value="${escapeHtml(suggestAppName(it.hostname))}">
          ${categorySelect(cats.order)}
          <button type="button" class="btn-inline" data-uncat-action="assign">Add</button>
        </span>
      </li>
    `).join("");
  }

  // ── per-category accordion (sorted by recent activity, then name) ─
  const ordered = [...cats.order].sort((a, b) => {
    const ar = cats.categories[a]?.count_recent_7d ?? 0;
    const br = cats.categories[b]?.count_recent_7d ?? 0;
    if (ar !== br) return br - ar;
    return a.localeCompare(b);
  });
  els.categoryList.innerHTML = ordered.map(cat => {
    const c = cats.categories[cat];
    if (!c) return "";
    const color = CATEGORY_COLORS[cat] || "#ccc";
    const entries = c.entries.slice().sort((a, b) => a.suffix.localeCompare(b.suffix));
    return `
      <details class="cat-block" data-cat="${cat}">
        <summary class="cat-summary">
          <span class="cat-swatch" style="background:${color}"></span>
          <span class="cat-name">${cat}</span>
          <span class="cat-counts">${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${c.count_recent_7d.toLocaleString()} queries/wk</span>
        </summary>
        <div class="cat-body">
          <ol class="rank-list cat-entries">
            ${entries.map(e => `
              <li class="rank-row cat-entry-row" data-suffix="${escapeHtml(e.suffix)}">
                <span class="rank-name">${escapeHtml(e.suffix)}</span>
                <span class="rank-meta">${escapeHtml(e.app)}</span>
                <span class="entry-source ${e.source === "user" ? "is-user" : ""}">${e.source}</span>
                <button type="button" class="prow-remove" data-cat-action="remove" data-suffix="${escapeHtml(e.suffix)}" title="${e.source === "user" ? "Remove this user entry" : "Override removed — adding a user entry with this suffix would replace it"}">×</button>
              </li>`).join("")}
          </ol>
          <div class="cat-add">
            <input type="text" class="cat-add-suffix" placeholder="example.com">
            <input type="text" class="cat-add-app"    placeholder="App name (e.g. Reddit)">
            <button type="button" class="btn-inline" data-cat-action="add" data-cat="${cat}">Add suffix</button>
          </div>
        </div>
      </details>`;
  }).join("");
}

// Default app name suggestion for a new uncategorized hostname.
// Strips common TLDs + subdomains and title-cases the core word.
function suggestAppName(host) {
  const parts = String(host || "").toLowerCase().split(".");
  if (parts.length < 2) return host;
  // Drop common TLD parts: .com .net .org .co .uk .au, plus a leading "www"
  const trimmed = parts.filter((p, i) => !(i === 0 && p === "www"));
  if (trimmed.length < 2) return host;
  const root = trimmed[trimmed.length - 2];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function categorySelect(order) {
  return `<select class="uncat-cat">${order.map(c => `<option value="${c}"${c === "social" ? " selected" : ""}>${c}</option>`).join("")}</select>`;
}

// Click delegation for the apps view
document.addEventListener("click", async (e) => {
  // Uncategorized → assign
  const assignBtn = e.target.closest('[data-uncat-action="assign"]');
  if (assignBtn) {
    e.preventDefault();
    const row = assignBtn.closest(".uncat-row");
    if (!row) return;
    const hostname = row.dataset.hostname;
    const app = row.querySelector(".uncat-app")?.value.trim();
    const category = row.querySelector(".uncat-cat")?.value;
    if (!app || !category) return;
    try {
      await jpost(`${API}/categories`, { action: "add", suffix: hostname, app, category });
      toast(`Added ${hostname} → ${app} (${category})`);
      loadAppsView();
    } catch (err) {
      toast(`Couldn't add: ${err.message}`, "error");
    }
    return;
  }

  // Category → add suffix
  const addBtn = e.target.closest('[data-cat-action="add"]');
  if (addBtn) {
    e.preventDefault();
    const block = addBtn.closest(".cat-block");
    if (!block) return;
    const suffix = block.querySelector(".cat-add-suffix")?.value.trim();
    const app    = block.querySelector(".cat-add-app")?.value.trim();
    const category = addBtn.dataset.cat;
    if (!suffix || !app || !category) {
      toast("Need both suffix and app name", "error");
      return;
    }
    try {
      await jpost(`${API}/categories`, { action: "add", suffix, app, category });
      toast(`Added ${suffix} → ${app} (${category})`);
      loadAppsView();
    } catch (err) {
      toast(`Couldn't add: ${err.message}`, "error");
    }
    return;
  }

  // Category → remove user entry
  const removeBtn = e.target.closest('[data-cat-action="remove"]');
  if (removeBtn) {
    e.preventDefault();
    const suffix = removeBtn.dataset.suffix;
    // Look up the entry's source — only allow removing user entries.
    const row = removeBtn.closest(".cat-entry-row");
    const source = row?.querySelector(".entry-source")?.textContent;
    if (source !== "user") {
      toast("Built-in entries can't be removed. Override by adding a user entry with the same suffix.", "error");
      return;
    }
    try {
      await jpost(`${API}/categories`, { action: "remove", suffix });
      toast(`Removed ${suffix}`);
      loadAppsView();
    } catch (err) {
      toast(`Couldn't remove: ${err.message}`, "error");
    }
  }
});

// ── activity view: policy actions feed + recent DNS blocks ──────────

async function loadActivityFeed() {
  els.activityFeed.innerHTML = "";
  els.activityEmpty.hidden = true;
  try {
    const actions = await jget(`${API}/policy/actions`).catch(() => []);
    if (!Array.isArray(actions) || actions.length === 0) {
      els.activityEmpty.hidden = false;
      return;
    }
    els.activityFeed.innerHTML = actions.slice().reverse().map(a => `
      <li class="activity-item">
        <div class="activity-when">${escapeHtml(fmtRelTime(a.ts))}</div>
        <div class="activity-body">
          <span class="activity-host">${escapeHtml(a.hostname)}</span>
          <span class="activity-meta">blocked for ${escapeHtml(a.name || a.mac)} — ${escapeHtml(a.severity)}: ${escapeHtml(a.reason || "")}</span>
        </div>
      </li>`).join("");
  } catch (err) {
    els.activityEmpty.textContent = `Failed to load activity: ${err.message}`;
    els.activityEmpty.hidden = false;
  }
}

// ── scan now ────────────────────────────────────────────────────────

async function runScanNow() {
  if (state.scanInFlight) return;
  state.scanInFlight = true;
  toast("Running policy scan…");
  try {
    const r = await jpost(`${API}/policy/scan`);
    toast(`Scan complete — ${r.scanned || 0} devices, ${r.flagged || 0} flagged, ${r.blocked || 0} blocked`);
    if (state.view === "activity") loadActivityFeed();
  } catch (err) {
    toast(`Scan failed: ${err.message}`, "error");
  } finally {
    state.scanInFlight = false;
  }
}

// ── initial fetch + WebSocket ──────────────────────────────────────

async function fetchAll() {
  try {
    const [status, devices] = await Promise.all([
      jget(`${API}/status`),
      jget(`${API}/devices`),
    ]);
    state.status = status;
    state.devices = new Map(devices.map(d => [d.mac, d]));
    renderDevices();
  } catch (err) {
    console.error("initial fetch failed:", err);
    els.summary.innerHTML = `<span style="color: var(--alarm)">Couldn't load network: ${escapeHtml(err.message)}</span>`;
  }
}

let ws = null;
let wsAttempts = 0;
let wsReconnectTimer = null;

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${WS_PATH}`;
}

function connectWS() {
  setLive("connecting");
  try { ws = new WebSocket(wsUrl()); }
  catch { scheduleReconnect(); return; }
  ws.onopen = () => { wsAttempts = 0; setLive("live"); };
  ws.onclose = () => { setLive("error"); scheduleReconnect(); };
  ws.onerror = () => { /* close fires after */ };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg?.type) return;
    if (msg.type === "network:device:update") return onDeviceUpdate(msg.data);
    if (msg.type === "network:status:update") return onStatusUpdate(msg.data);
    if (msg.type === "network:device:remove") return onDeviceRemove(msg.data);
    if (msg.type === "network:policy:flagged") return onPolicyFlagged(msg.data);
    if (msg.type === "network:policy:blocked") return onPolicyBlocked(msg.data);
  };
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsAttempts++;
  const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(wsAttempts, 5)));
  wsReconnectTimer = setTimeout(connectWS, delay);
}

function onDeviceUpdate(data) {
  if (!data?.mac) return;
  const d = state.devices.get(data.mac);
  if (d) Object.assign(d, data);
  else   state.devices.set(data.mac, data);
  if (state.view === "devices") renderDevices();
  if (state.view === "blocks")  renderBlocks();
  if (state.view === "people")  renderPeople();
}
function onStatusUpdate(data) { state.status = { ...state.status, ...data }; renderSummary(); }
function onDeviceRemove(data) { if (data?.mac) state.devices.delete(data.mac); renderDevices(); }
function onPolicyFlagged(data) {
  if (state.view === "activity") loadActivityFeed();
  toast(`Flagged: ${data.hostname || "unknown"} (${data.severity || "?"})`);
}
function onPolicyBlocked(data) {
  if (state.view === "activity") loadActivityFeed();
  toast(`Auto-blocked ${data.hostname || "unknown"} on ${data.mac || "device"}`, "ok", 4500);
}

// ── wire-up ─────────────────────────────────────────────────────────

function init() {
  els.sidebarHost.textContent = location.host;

  // sidebar nav
  for (const n of $$(".navitem")) {
    n.addEventListener("click", () => setView(n.dataset.view));
  }

  // filter pills
  for (const p of $$(".pill")) {
    p.addEventListener("click", () => {
      for (const x of $$(".pill")) {
        x.classList.toggle("is-on", x === p);
        x.setAttribute("aria-selected", String(x === p));
      }
      state.filter = p.dataset.filter;
      renderDevices();
    });
  }

  // sort headers
  for (const th of $$(".th[data-sort]")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.key = key; state.sort.dir = "desc"; }
      for (const x of $$(".th[data-sort]")) {
        x.classList.toggle("is-sorted-asc",  x.dataset.sort === state.sort.key && state.sort.dir === "asc");
        x.classList.toggle("is-sorted-desc", x.dataset.sort === state.sort.key && state.sort.dir === "desc");
      }
      renderDevices();
    });
  }

  // search
  els.searchInput?.addEventListener("input", () => {
    state.search = els.searchInput.value;
    renderDevices();
  });
  document.addEventListener("keydown", (e) => {
    const inField = ["INPUT", "TEXTAREA"].includes(e.target.tagName) || e.target.closest?.("[contenteditable]");
    if (inField) return;
    if (e.key === "/") {
      e.preventDefault();
      els.searchInput?.focus();
      els.searchInput?.select();
      return;
    }
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      moveCursor(e.key === "j" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" && state.cursorMac) {
      const row = $(`.trow[data-mac="${cssEscape(state.cursorMac)}"]`);
      if (row) { e.preventDefault(); toggleDetails(row); }
    }
  });

  // keyboard cursor helper — moves the .is-active-keyboard highlight
  function moveCursor(dir) {
    const rows = $$(".trow");
    if (!rows.length) return;
    let idx = rows.findIndex(r => r.dataset.mac === state.cursorMac);
    if (idx === -1) idx = dir > 0 ? -1 : 0;
    idx = Math.max(0, Math.min(rows.length - 1, idx + dir));
    rows.forEach(r => r.classList.remove("is-active-keyboard"));
    const target = rows[idx];
    state.cursorMac = target.dataset.mac;
    target.classList.add("is-active-keyboard");
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  }

  // hamburger (mobile)
  els.hamburger?.addEventListener("click", () => {
    const open = els.sidebar.classList.toggle("is-open");
    els.hamburger.setAttribute("aria-expanded", String(open));
  });

  // scan-now buttons
  els.scanNowBtn?.addEventListener("click", runScanNow);
  els.scanNowBtn2?.addEventListener("click", runScanNow);

  // people-detail back button + range switcher
  els.peopleBackBtn?.addEventListener("click", closePeopleDetail);
  for (const pill of $$("#peopleDetailView .range-pills .pill")) {
    pill.addEventListener("click", () => {
      const days = parseInt(pill.dataset.range, 10);
      if (!days || days === detailState.days) {
        for (const x of $$("#peopleDetailView .range-pills .pill")) {
          x.classList.toggle("is-on", x === pill);
          x.setAttribute("aria-selected", String(x === pill));
        }
        return;
      }
      detailState.days = days;
      for (const x of $$("#peopleDetailView .range-pills .pill")) {
        x.classList.toggle("is-on", x === pill);
        x.setAttribute("aria-selected", String(x === pill));
      }
      if (detailState.subject) loadDetailHistory(detailState.subject, days);
    });
  }

  // initial load
  fetchAll().then(connectWS);

  // refresh "X ago" labels every minute
  setInterval(() => {
    if (state.view === "devices") renderDevices();
    if (state.view === "blocks")  renderBlocks();
  }, 60_000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
