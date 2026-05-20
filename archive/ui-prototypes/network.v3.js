// ════════════════════════════════════════════════════════════════════
// gombwe — network (v3)
// Editorial dashboard. Behaviour from v2; markup is fresh.
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
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(dp)} ${units[i]}`;
};

const fmtBytesShort = (n) => {
  if (n == null || isNaN(n)) return "0";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return `${v.toFixed(dp)} ${units[i]}`;
};

// returns { value: "1.2", unit: "GB" } for editorial hero display
const splitBytes = (n) => {
  if (n == null || isNaN(n) || n <= 0) return { value: "0", unit: "B" };
  if (n < 1024) return { value: String(n), unit: "B" };
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return { value: v.toFixed(dp), unit: units[i] };
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

// ── state ───────────────────────────────────────────────────────────

const state = {
  devices: new Map(),         // mac -> device
  status: null,
  expandedPeople: new Set(),  // person names currently expanded
  expandedDetails: new Set(), // macs whose details panel is open
  wsConnected: false,
  ownerOverrides: {},         // mac -> person | "__household__"
  pendingAssignMac: null,
};

const els = {
  statusDot:        $("#statusDot"),
  statusText:       $("#statusText"),

  figDevices:       $("#figDevices"),
  figPeople:        $("#figPeople"),
  figData:          $("#figData"),
  figDataLabel:     $("#figDataLabel"),

  peopleList:       $("#peopleList"),
  peopleEmpty:      $("#peopleEmpty"),
  peopleSub:        $("#peopleSub"),

  householdList:    $("#householdList"),
  householdEmpty:   $("#householdEmpty"),
  hhSub:            $("#hhSub"),

  personTpl:        $("#tpl-person-row"),
  deviceTpl:        $("#tpl-device-row"),

  modalScrim:       $("#modalScrim"),
  assignModal:      $("#assignModal"),
  assignClose:      $("#assignClose"),
  assignDeviceName: $("#assignDeviceName"),
  assignOptions:    $("#assignOptions"),
  assignNewName:    $("#assignNewName"),
  assignNewBtn:     $("#assignNewBtn"),
  assignClear:      $("#assignClear"),

  toasts:           $("#toasts"),
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

// ── person heuristic (carries from v2) ──────────────────────────────

const HOUSEHOLD_HINTS = [
  "tv", "printer", "router", "hub", "switch", "iot", "echo", "alexa",
  "google home", "nest", "ring", "smart", "thermostat", "doorbell",
  "camera", "speaker", "chromecast", "sonos", "philips hue", "hue",
  "brw", "mxchip", "esp", "shelly", "lifx",
];

const NAME_HINT_RE = /^([A-Za-z][a-z]{1,19})['’]s\s+/;
const NAME_DASH_RE = /^([A-Za-z][a-z]{1,19})[-_]/;

function guessOwner(device) {
  const override = state.ownerOverrides[device.mac];
  if (override === "__household__") return null;
  if (override) return override;

  // server may also carry an owner field directly
  if (device.owner && device.owner !== "__household__") return device.owner;

  const raw = (device.name || device.hostname || "").trim();
  if (!raw) return null;

  const low = raw.toLowerCase();
  if (HOUSEHOLD_HINTS.some(h => low.includes(h))) return null;

  const m = raw.match(NAME_HINT_RE) || raw.match(NAME_DASH_RE);
  if (m) {
    const candidate = m[1];
    return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
  }
  return null;
}

const initialsFor = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

// ── status line ─────────────────────────────────────────────────────

function setLive(stateName) {
  els.statusDot.dataset.state = stateName;
}

function renderStatusLine() {
  const devs = [...state.devices.values()];
  const online  = devs.filter(d => d.online).length;
  const paused  = devs.filter(d => d.blocked).length;
  const total   = devs.length;

  if (!state.wsConnected) {
    setLive("connecting");
    els.statusText.textContent = total ? `Reconnecting · ${total} tracked` : "Connecting";
  } else {
    setLive("live");
    const pausedFrag = paused ? ` · ${paused} paused` : "";
    els.statusText.textContent = `Live · ${online} of ${total} online${pausedFrag}`;
  }
}

// ── grouping ────────────────────────────────────────────────────────

function buildGroups() {
  const people = new Map();
  const household = [];

  for (const d of state.devices.values()) {
    const owner = guessOwner(d);
    if (!owner) {
      household.push(d);
      continue;
    }
    if (!people.has(owner)) {
      people.set(owner, { name: owner, devices: [], online: 0, paused: 0, todayBytes: 0 });
    }
    const g = people.get(owner);
    g.devices.push(d);
    if (d.online)  g.online++;
    if (d.blocked) g.paused++;
    g.todayBytes += (d.today_bytes_down || 0) + (d.today_bytes_up || 0);
  }

  const sortedPeople = [...people.values()].sort((a, b) => {
    if (b.devices.length !== a.devices.length) return b.devices.length - a.devices.length;
    return a.name.localeCompare(b.name);
  });
  household.sort((a, b) => (a.name || a.mac).localeCompare(b.name || b.mac));

  return { people: sortedPeople, household };
}

function sortDevicesForDisplay(arr) {
  return [...arr].sort((a, b) => {
    const weight = (d) => d.blocked ? 0 : d.online ? 1 : 2;
    const aw = weight(a), bw = weight(b);
    if (aw !== bw) return aw - bw;
    return (a.name || a.mac).localeCompare(b.name || b.mac);
  });
}

// ── hero figures ────────────────────────────────────────────────────

function renderHero(people, household) {
  const devs = [...state.devices.values()];
  const total = devs.length;
  const peopleActive = people.filter(p => p.online > 0).length;
  const totalBytes = devs.reduce((a, d) => a + (d.today_bytes_down || 0) + (d.today_bytes_up || 0), 0);

  els.figDevices.textContent = total;
  els.figPeople.textContent = peopleActive;

  const { value, unit } = splitBytes(totalBytes);
  els.figData.innerHTML = `${escapeHtml(value)}<span class="unit">${escapeHtml(unit)}</span>`;
}

// ── people list ─────────────────────────────────────────────────────

function renderPeople(people) {
  els.peopleList.innerHTML = "";

  if (!people.length) {
    els.peopleEmpty.hidden = false;
    els.peopleSub.textContent = "No people yet.";
    return;
  }
  els.peopleEmpty.hidden = true;

  const totalOnline = people.reduce((a, p) => a + p.online, 0);
  const totalPaused = people.reduce((a, p) => a + p.paused, 0);
  els.peopleSub.textContent = totalPaused
    ? `${people.length} people · ${totalOnline} online · ${totalPaused} paused`
    : `${people.length} people · ${totalOnline} online`;

  for (const p of people) {
    els.peopleList.appendChild(buildPersonRow(p));
  }
}

function buildPersonRow(p) {
  const node = els.personTpl.content.firstElementChild.cloneNode(true);
  const trigger = $(".row-trigger", node);
  const expanded = state.expandedPeople.has(p.name);

  $('[data-bind="monogram"]', node).textContent = initialsFor(p.name);
  $('[data-bind="name"]',     node).textContent = p.name;
  $('[data-bind="sub"]',      node).innerHTML  = personSubLine(p);
  $('[data-bind="meta1"]',    node).textContent = `${p.devices.length} ${p.devices.length === 1 ? "device" : "devices"}`;
  $('[data-bind="meta2"]',    node).textContent = personMetaSecondary(p);

  trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
  trigger.addEventListener("click", () => togglePerson(p.name));

  const children = $('[data-bind="children"]', node);
  if (expanded) {
    children.hidden = false;
    const sorted = sortDevicesForDisplay(p.devices);
    const inner = document.createElement("ol");
    inner.className = "rowlist";
    inner.style.borderTop = "0";
    for (const d of sorted) inner.appendChild(buildDeviceRow(d));
    children.appendChild(inner);
  }
  return node;
}

function personSubLine(p) {
  if (p.paused) {
    return `<strong>${p.paused} paused</strong> · ${p.online} online`;
  }
  if (p.online === 0) {
    return `all offline`;
  }
  if (p.todayBytes > 0) {
    return `${fmtBytesShort(p.todayBytes)} today`;
  }
  return `quiet today`;
}

function personMetaSecondary(p) {
  if (p.paused) return "attention";
  if (p.online) return "online";
  return "offline";
}

function togglePerson(name) {
  if (state.expandedPeople.has(name)) state.expandedPeople.delete(name);
  else state.expandedPeople.add(name);
  renderAll();
}

// ── household list ──────────────────────────────────────────────────

function renderHousehold(household) {
  els.householdList.innerHTML = "";

  if (!household.length) {
    els.householdEmpty.hidden = false;
    els.hhSub.textContent = "—";
    return;
  }
  els.householdEmpty.hidden = true;

  const online = household.filter(d => d.online).length;
  els.hhSub.textContent = `${household.length} ${household.length === 1 ? "device" : "devices"} · ${online} online`;

  for (const d of sortDevicesForDisplay(household)) {
    els.householdList.appendChild(buildDeviceRow(d));
  }
}

// ── device row ──────────────────────────────────────────────────────

const rowEls = new Map();          // mac -> row element (most recently rendered)
const countdownTimers = new Map(); // mac -> intervalId

function buildDeviceRow(d) {
  const row = els.deviceTpl.content.firstElementChild.cloneNode(true);
  populateDeviceRow(row, d);
  rowEls.set(d.mac, row);
  return row;
}

function populateDeviceRow(row, d) {
  row.dataset.mac = d.mac;
  row.dataset.kid = d.kid ? "true" : "false";
  const cardState = d.blocked ? "paused" : d.online ? "online" : "offline";
  row.dataset.state = cardState;

  // Visible name with a small "kid" tag when on the kid list, so it's obvious
  // at a glance which devices are policy-scanned. The tag is plain text styled
  // by CSS — no emoji, no colour beyond the existing palette.
  const nameEl = $('[data-bind="name"]', row);
  nameEl.textContent = d.name || d.hostname || d.mac;
  if (d.kid) {
    const tag = document.createElement('span');
    tag.className = 'kid-tag';
    tag.textContent = 'kid';
    nameEl.appendChild(document.createTextNode(' '));
    nameEl.appendChild(tag);
  }

  $('[data-bind="activity"]', row).innerHTML   = activityLine(d);

  const blockBtn = $('[data-bind="blockBtn"]', row);
  blockBtn.textContent = d.blocked ? "Resume" : "Pause";

  // Menu label flips based on current state
  const kidToggle = $('[data-bind="kidToggle"]', row);
  if (kidToggle) kidToggle.textContent = d.kid ? "Remove from kid list" : "Add to kid list";

  attachCountdown(row, d);

  const detailsOpen = state.expandedDetails.has(d.mac);
  const detailsEl = $('[data-bind="details"]', row);
  detailsEl.hidden = !detailsOpen;
  if (detailsOpen) populateDetails(row, d);

  // wire interactions
  row.addEventListener("click", onRowClick);
  row.addEventListener("keydown", onRowKey);
}

function activityLine(d) {
  if (d.blocked) {
    if (d.block_expires) {
      const ms = new Date(d.block_expires).getTime() - Date.now();
      if (ms > 0) {
        const mins = Math.ceil(ms / 60000);
        return `Paused — resumes in ${humanMinutes(mins)}`;
      }
    }
    return `Paused`;
  }
  if (!d.online) {
    return `Asleep · last seen ${escapeHtml(fmtRelTime(d.last_seen))}`;
  }

  const dests = Array.isArray(d.top_destinations_today) ? d.top_destinations_today : [];
  const top = dests[0];
  const totalBytes = (d.today_bytes_down || 0) + (d.today_bytes_up || 0);

  if (top && top.host) {
    const friendlyHost = friendlyHostName(top.host);
    if (totalBytes > 0) {
      return `On <strong>${escapeHtml(friendlyHost)}</strong> · ${escapeHtml(fmtBytesShort(totalBytes))} today`;
    }
    return `On <strong>${escapeHtml(friendlyHost)}</strong> · just connected`;
  }

  if (totalBytes > 0) {
    const sites = dests.length;
    if (sites) return `${sites} ${sites === 1 ? "site" : "sites"} visited · ${escapeHtml(fmtBytesShort(totalBytes))} today`;
    return `${escapeHtml(fmtBytesShort(totalBytes))} of activity today`;
  }
  return `Connected · idle`;
}

function friendlyHostName(host) {
  if (!host) return "the web";
  let h = host.replace(/^www\./, "");
  const known = {
    "youtube.com": "YouTube", "youtu.be": "YouTube",
    "netflix.com": "Netflix",
    "google.com": "Google",
    "spotify.com": "Spotify",
    "tiktok.com": "TikTok",
    "instagram.com": "Instagram",
    "facebook.com": "Facebook",
    "reddit.com": "Reddit",
    "twitch.tv": "Twitch",
    "discord.com": "Discord", "discordapp.com": "Discord",
    "roblox.com": "Roblox",
    "minecraft.net": "Minecraft",
    "apple.com": "Apple", "icloud.com": "iCloud",
    "github.com": "GitHub",
    "amazon.com": "Amazon",
    "twitter.com": "Twitter", "x.com": "X",
  };
  for (const [k, v] of Object.entries(known)) {
    if (h === k || h.endsWith("." + k)) return v;
  }
  const parts = h.split(".");
  if (parts.length >= 2) h = parts.slice(-2).join(".");
  return h;
}

// ── details panel ───────────────────────────────────────────────────

function populateDetails(row, d) {
  $('[data-bind="dIp"]',       row).textContent = d.ip  || "—";
  $('[data-bind="dMac"]',      row).textContent = d.mac;
  $('[data-bind="dVendor"]',   row).textContent = d.vendor || "Unknown";
  $('[data-bind="dLastSeen"]', row).textContent = fmtRelTime(d.last_seen);
  $('[data-bind="dConns"]',    row).textContent = d.active_connections ?? 0;
  const totalDown = d.today_bytes_down || 0;
  const totalUp   = d.today_bytes_up   || 0;
  $('[data-bind="dToday"]',    row).textContent = `${fmtBytes(totalDown)} down · ${fmtBytes(totalUp)} up`;

  // All destinations (was top 5; now full list, scrollable container)
  const destsCount = Array.isArray(d.top_destinations_today) ? d.top_destinations_today.length : 0;
  $('[data-bind="destsCount"]', row).textContent = destsCount ? `(${destsCount} unique destinations today)` : '';
  $('[data-bind="dests"]', row).innerHTML = renderDestList(d.top_destinations_today);
  $('[data-bind="spark"]', row).innerHTML = buildSparkline(d);

  // DNS query history — fire and forget; updates the panel when the
  // response lands. Don't block the rest of the details rendering.
  loadDnsHistory(row, d.ip).catch(err => {
    console.warn('dns history load failed', err);
    $('[data-bind="dnsList"]', row).innerHTML =
      `<li class="dns-empty">Couldn't load DNS history: ${escapeHtml(err.message)}</li>`;
  });
}

function renderDestList(dests) {
  if (!Array.isArray(dests) || dests.length === 0) {
    return `<li><span class="host dim">No traffic recorded today</span><span></span></li>`;
  }
  // Show ALL destinations, not just top 5. The container is scrollable.
  return dests.map(d => `
    <li>
      <span class="host">${escapeHtml(friendlyHostName(d.host))}</span>
      <span class="bytes">${escapeHtml(fmtBytesShort(d.bytes))}</span>
    </li>
  `).join("");
}

async function loadDnsHistory(row, ip) {
  if (!ip) return;
  const data = await jget(`${API}/dns/recent?client=${encodeURIComponent(ip)}&limit=500`);
  const listEl = $('[data-bind="dnsList"]', row);
  const countEl = $('[data-bind="dnsCount"]', row);
  if (!Array.isArray(data) || data.length === 0) {
    listEl.innerHTML = `<li class="dns-empty">No DNS queries yet — try refreshing in 30s.</li>`;
    countEl.textContent = '';
    return;
  }
  // Newest first. Deduplicate by hostname for the headline list, but keep a
  // counter so the user knows how often it was hit. Latest timestamp wins.
  const byHost = new Map();
  for (const q of data) {
    const e = byHost.get(q.hostname) ?? { count: 0, last_ts: '', type: q.type, blocked: false };
    e.count += 1;
    if (q.ts > e.last_ts) e.last_ts = q.ts;
    if (q.blocked) e.blocked = true;
    byHost.set(q.hostname, e);
  }
  countEl.textContent = `(${data.length} queries · ${byHost.size} unique hostnames)`;
  const rows = [...byHost.entries()]
    .sort((a, b) => b[1].last_ts.localeCompare(a[1].last_ts))
    .map(([host, e]) => `
      <li class="dns-row ${e.blocked ? 'is-blocked' : ''}">
        <span class="dns-host">${escapeHtml(host)}</span>
        <span class="dns-meta">${escapeHtml(fmtRelTime(e.last_ts))} · ${e.count}×${e.blocked ? ' · blocked' : ''}</span>
      </li>`).join('');
  listEl.innerHTML = rows;
}

function buildSparkline(device) {
  const total = (device.today_bytes_down || 0) + (device.today_bytes_up || 0);
  if (!total) {
    return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="42" x2="100" y2="42" stroke="rgba(0,0,0,0.08)" stroke-width="0.6" stroke-dasharray="2 2"/>
    </svg>`;
  }
  const N = 24;
  device._series ||= pseudoSeries(N, device.mac, total);
  const series = device._series;
  const max = Math.max(...series, 1);
  const pts = series.map((v, i) => {
    const x = (i / (N - 1)) * 100;
    const y = 42 - (v / max) * 38;
    return [x, y];
  });
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" ");
  const stroke = device.blocked ? "#C8392E" : "#0A0A0A";

  return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(2)}" cy="${pts[pts.length - 1][1].toFixed(2)}" r="1.4" fill="${stroke}"/>
  </svg>`;
}

function pseudoSeries(N, seed, total) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619 >>> 0;
  const rng = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
  const raw = Array.from({ length: N }, () => 0.4 + rng() * 0.6);
  for (let p = 0; p < 2; p++) {
    for (let i = 1; i < N - 1; i++) raw[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3;
  }
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map(v => Math.floor((v / sum) * total));
}

// ── countdown ──────────────────────────────────────────────────────

function attachCountdown(row, d) {
  const prev = countdownTimers.get(d.mac);
  if (prev) { clearInterval(prev); countdownTimers.delete(d.mac); }
  if (!d.blocked || !d.block_expires) return;

  const id = setInterval(() => {
    const live = state.devices.get(d.mac);
    if (!live || !live.blocked || !live.block_expires) {
      clearInterval(id); countdownTimers.delete(d.mac); return;
    }
    const liveRow = rowEls.get(d.mac);
    if (!liveRow || !document.body.contains(liveRow)) {
      clearInterval(id); countdownTimers.delete(d.mac); return;
    }
    $('[data-bind="activity"]', liveRow).innerHTML = activityLine(live);
  }, 1000);
  countdownTimers.set(d.mac, id);
}

// ── row interactions ───────────────────────────────────────────────

function onRowKey(e) {
  if (e.key === "Enter" || e.key === " ") {
    const tgt = e.target;
    if (tgt.classList && tgt.classList.contains("row-trigger-device")) {
      e.preventDefault();
      toggleDetails(e.currentTarget);
    }
  }
}

function onRowClick(e) {
  const row = e.currentTarget;
  const mac = row.dataset.mac;
  const actionEl = e.target.closest("[data-action]");
  if (actionEl) {
    e.stopPropagation();
    const action = actionEl.dataset.action;
    if (action === "block")          return onPrimaryBlock(mac);
    if (action === "menu")           return toggleMenu(row);
    if (action === "rename")         return startRename(row, mac);
    if (action === "assign")         { closeAllMenus(); return openAssignModal(mac); }
    if (action === "toggle-kid")     { closeAllMenus(); return toggleKid(mac); }
    if (action === "toggle-details") { closeAllMenus(); return toggleDetails(row); }
    return;
  }
  const item = e.target.closest(".menu-item");
  if (item && item.dataset.mins != null) {
    e.stopPropagation();
    closeAllMenus();
    return blockWithDuration(mac, item.dataset.mins);
  }
  // click on the device row body itself → expand details
  if (e.target.closest(".row-body") || e.target.classList.contains("row-trigger-device")) {
    if (!e.target.closest("[contenteditable]")) {
      toggleDetails(row);
    }
  }
}

function toggleMenu(row) {
  const menu = $('[data-bind="menu"]', row);
  const trigger = $('[data-action="menu"]', row);
  const wasOpen = !menu.hidden;
  closeAllMenus();
  if (!wasOpen) {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
}

function closeAllMenus() {
  $$(".menu").forEach(m => m.hidden = true);
  $$('[data-action="menu"]').forEach(t => t.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu") && !e.target.closest('[data-action="menu"]')) closeAllMenus();
});

function toggleDetails(row) {
  const mac = row.dataset.mac;
  if (!mac) return;
  const open = state.expandedDetails.has(mac);
  const detailsEl = $('[data-bind="details"]', row);
  if (open) {
    state.expandedDetails.delete(mac);
    detailsEl.hidden = true;
  } else {
    state.expandedDetails.add(mac);
    const d = state.devices.get(mac);
    if (d) populateDetails(row, d);
    detailsEl.hidden = false;
  }
}

// ── rename (inline) ────────────────────────────────────────────────

function startRename(row, mac) {
  const nameEl = $('[data-bind="name"]', row);
  if (nameEl.classList.contains("editing")) return;
  const old = nameEl.textContent;
  nameEl.classList.add("editing");
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);

  const finish = async (commit) => {
    nameEl.removeAttribute("contenteditable");
    nameEl.classList.remove("editing");
    nameEl.removeEventListener("keydown", onKey);
    nameEl.removeEventListener("blur", onBlur);
    const v = nameEl.textContent.trim();
    if (!commit || !v || v === old) {
      nameEl.textContent = old;
      return;
    }
    const d = state.devices.get(mac);
    const prev = d.name;
    d.name = v;
    try {
      await jpost(`${API}/devices/${encodeURIComponent(mac)}/name`, { name: v });
      toast(`Renamed to ${v}`);
      renderAll();
    } catch (err) {
      d.name = prev;
      nameEl.textContent = prev;
      toast(`Couldn't rename: ${err.message}`, "error");
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter")       { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  nameEl.addEventListener("keydown", onKey);
  nameEl.addEventListener("blur", onBlur);
}

// ── block / unblock ────────────────────────────────────────────────

function durationToMinutes(spec) {
  if (spec === "until_tomorrow") {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    return Math.max(1, Math.floor((t.getTime() - Date.now()) / 60000));
  }
  const n = parseInt(spec, 10);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

async function onPrimaryBlock(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  if (d.blocked) return unblockDevice(mac);
  return blockWithDuration(mac, "30");
}

async function blockWithDuration(mac, spec) {
  const d = state.devices.get(mac);
  if (!d) return;
  const minutes = durationToMinutes(spec);

  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = true;
  d.block_expires = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  renderAll();

  try {
    const res = await jpost(`${API}/devices/${encodeURIComponent(mac)}/block`,
      minutes ? { duration_minutes: minutes } : {});
    if (res?.blocked_until !== undefined) d.block_expires = res.blocked_until;
    renderAll();
    const friendly = d.name || "Device";
    toast(minutes ? `Paused ${friendly} for ${humanMinutes(minutes)}` : `Paused ${friendly}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderAll();
    toast(`Couldn't pause: ${err.message}`, "error");
  }
}

async function toggleKid(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  const next = !d.kid;
  // Optimistic flip — paint the new state immediately, revert on failure.
  d.kid = next;
  renderAll();
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/kid`, { enabled: next });
    const friendly = d.name || "device";
    toast(next
      ? `${friendly} added to kid list — auto-scanner will check every 10 min`
      : `${friendly} removed from kid list — no more auto-scans`);
  } catch (err) {
    d.kid = !next;
    renderAll();
    toast(`Couldn't update kid list: ${err.message}`, "error");
  }
}

async function unblockDevice(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = false;
  d.block_expires = null;
  renderAll();
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/unblock`);
    toast(`Resumed ${d.name || "device"}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderAll();
    toast(`Couldn't resume: ${err.message}`, "error");
  }
}

// ── assign-to-person modal ─────────────────────────────────────────

function openAssignModal(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  state.pendingAssignMac = mac;
  els.assignDeviceName.textContent = d.name || d.hostname || d.mac;

  const { people } = buildGroups();
  els.assignOptions.innerHTML = "";
  for (const p of people) {
    const btn = document.createElement("button");
    btn.className = "assign-option";
    btn.type = "button";
    btn.innerHTML = `
      <span class="monogram">${escapeHtml(initialsFor(p.name))}</span>
      <span>${escapeHtml(p.name)}</span>
    `;
    btn.addEventListener("click", () => commitAssign(p.name));
    els.assignOptions.appendChild(btn);
  }
  if (!people.length) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:13px;color:var(--ink-4);margin:0 0 8px;padding:12px 0;";
    note.textContent = "No people yet. Add the first one below.";
    els.assignOptions.appendChild(note);
  }

  els.assignNewName.value = "";
  els.modalScrim.hidden = false;
  els.assignModal.hidden = false;
  setTimeout(() => els.assignNewName.focus(), 80);
}

function closeAssignModal() {
  els.modalScrim.hidden = true;
  els.assignModal.hidden = true;
  state.pendingAssignMac = null;
}

async function commitAssign(personName) {
  const mac = state.pendingAssignMac;
  if (!mac) return;
  const name = personName.trim();
  if (!name) return;

  const prevOverride = state.ownerOverrides[mac];
  state.ownerOverrides[mac] = name;
  closeAssignModal();
  renderAll();

  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/owner`, { owner: name });
    toast(`Assigned to ${name}`);
  } catch (err) {
    if (prevOverride === undefined) delete state.ownerOverrides[mac];
    else state.ownerOverrides[mac] = prevOverride;
    renderAll();
    toast(`Couldn't assign: ${err.message}`, "error");
  }
}

async function commitClearOwner() {
  const mac = state.pendingAssignMac;
  if (!mac) return;
  const prev = state.ownerOverrides[mac];
  state.ownerOverrides[mac] = "__household__";
  closeAssignModal();
  renderAll();

  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/owner`, { owner: null });
    toast("Moved to household devices");
  } catch (err) {
    if (prev === undefined) delete state.ownerOverrides[mac];
    else state.ownerOverrides[mac] = prev;
    renderAll();
    toast(`Couldn't move: ${err.message}`, "error");
  }
}

// ── master render ──────────────────────────────────────────────────

function renderAll() {
  const { people, household } = buildGroups();
  renderHero(people, household);
  renderPeople(people);
  renderHousehold(household);
  renderStatusLine();
}

// ── WebSocket ──────────────────────────────────────────────────────

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
  catch (e) { scheduleReconnect(); return; }

  ws.addEventListener("open", () => {
    state.wsConnected = true;
    wsAttempts = 0;
    renderStatusLine();
  });
  ws.addEventListener("message", (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleWSEvent(msg);
  });
  ws.addEventListener("close", () => {
    state.wsConnected = false;
    renderStatusLine();
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try { ws.close(); } catch {}
  });
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(wsAttempts, 5)));
  wsAttempts++;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWS();
  }, delay);
}

function handleWSEvent(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "network:device:update") {
    const { type, mac, ...rest } = msg;
    if (!mac) return;
    const prev = state.devices.get(mac) || { mac };
    const next = { ...prev, ...rest, mac };
    state.devices.set(mac, next);
    renderAll();
  } else if (msg.type === "network:status:update") {
    state.status = { ...(state.status || {}), ...msg };
    renderStatusLine();
  } else if (msg.type === "network:device:remove") {
    state.devices.delete(msg.mac);
    state.expandedDetails.delete(msg.mac);
    renderAll();
  }
}

// ── boot ───────────────────────────────────────────────────────────

async function boot() {
  els.assignClose.addEventListener("click", closeAssignModal);
  els.modalScrim.addEventListener("click", closeAssignModal);
  els.assignClear.addEventListener("click", commitClearOwner);
  els.assignNewBtn.addEventListener("click", () => {
    const name = els.assignNewName.value.trim();
    if (name) commitAssign(name);
  });
  els.assignNewName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const name = els.assignNewName.value.trim();
      if (name) commitAssign(name);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!els.assignModal.hidden) closeAssignModal();
      else closeAllMenus();
    }
  });

  setLive("connecting");
  try {
    const [status, devices] = await Promise.all([
      jget(`${API}/status`).catch(() => null),
      jget(`${API}/devices`).catch(() => []),
    ]);
    state.status = status;
    if (Array.isArray(devices)) {
      for (const d of devices) {
        state.devices.set(d.mac, d);
        if (d.owner && d.owner !== "__household__") {
          state.ownerOverrides[d.mac] = d.owner;
        }
      }
    }
    renderAll();
  } catch (err) {
    toast(`Couldn't load network: ${err.message}`, "error");
    renderAll();
  }

  connectWS();
  setInterval(() => renderAll(), 30_000);
}

document.addEventListener("DOMContentLoaded", boot);
