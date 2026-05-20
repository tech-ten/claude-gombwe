// ════════════════════════════════════════════════════════════════════
// gombwe — network (v2)
// Person-first family dashboard. Vanilla ES, no build step.
// ════════════════════════════════════════════════════════════════════

const API     = "/api/network";
const WS_PATH = "/ws";
const OWNER_STORAGE_KEY = "gombwe.network.ownerOverrides.v1";

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
  expandedPerson: null,       // person key currently expanded
  expandedDetails: new Set(), // macs whose Details panel is open
  wsConnected: false,
  ownerOverrides: loadOwnerOverrides(), // mac -> person | "__household__" | null
  ownerEndpointAvailable: true,         // flips to false if we ever 404
  pendingAssignMac: null,
};

const els = {
  liveDot:        $("#liveDot"),
  statusText:     $("#statusText"),

  peopleRow:      $("#peopleRow"),
  peopleEmpty:    $("#peopleEmpty"),
  personGroups:   $("#personGroups"),
  familySub:      $("#familySub"),

  householdGrid:  $("#householdGrid"),
  householdEmpty: $("#householdEmpty"),
  householdSub:   $("#householdSub"),

  cardTpl:        $("#tpl-device-card"),

  modalScrim:     $("#modalScrim"),
  assignModal:    $("#assignModal"),
  assignClose:    $("#assignClose"),
  assignDeviceName: $("#assignDeviceName"),
  assignOptions:  $("#assignOptions"),
  assignNewName:  $("#assignNewName"),
  assignNewBtn:   $("#assignNewBtn"),
  assignClear:    $("#assignClear"),

  toasts:         $("#toasts"),
};

// ── persistence helpers (owner overrides) ───────────────────────────

function loadOwnerOverrides() {
  try {
    const raw = localStorage.getItem(OWNER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch { return {}; }
}
function saveOwnerOverrides() {
  try { localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(state.ownerOverrides)); }
  catch {}
}

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
  // tolerate empty body
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

// ── person heuristic ────────────────────────────────────────────────
// We need to guess an owner from device.name. Rules:
//   1. If we have a manual override for this MAC, use that.
//   2. If name starts with "X's …" or "X'…" or "X-…" treat X as a person if
//      X is a plausible first name (1 word, alphabetic, length 2-20).
//   3. Otherwise → household.

const HOUSEHOLD_HINTS = [
  "tv", "printer", "router", "hub", "switch", "iot", "echo", "alexa",
  "google home", "nest", "ring", "smart", "thermostat", "doorbell",
  "camera", "speaker", "chromecast", "sonos", "philips hue", "hue",
  "brw", "mxchip", "esp", "shelly", "lifx",
];

const NAME_HINT_RE = /^([A-Za-z][a-z]{1,19})['’]s\s+/;     // "Sarah's iPhone"
const NAME_DASH_RE = /^([A-Za-z][a-z]{1,19})[-_]/;          // "Sarah-laptop"

function guessOwner(device) {
  const override = state.ownerOverrides[device.mac];
  if (override === "__household__") return null;
  if (override) return override;

  const raw = (device.name || device.hostname || "").trim();
  if (!raw) return null;

  const low = raw.toLowerCase();
  if (HOUSEHOLD_HINTS.some(h => low.includes(h))) return null;

  const m = raw.match(NAME_HINT_RE) || raw.match(NAME_DASH_RE);
  if (m) {
    const candidate = m[1];
    // Capitalize
    return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
  }
  return null;
}

// stable colour per person name
const PERSON_TONES = ["sage", "coral", "amber", "sky", "plum", "teal", "rose"];
function toneFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PERSON_TONES[h % PERSON_TONES.length];
}
const initialsFor = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

// ── status line ─────────────────────────────────────────────────────

function setLive(stateName) {
  els.liveDot.dataset.state = stateName;
}

function renderStatusLine() {
  const devs = [...state.devices.values()];
  const online  = devs.filter(d => d.online).length;
  const paused  = devs.filter(d => d.blocked).length;
  const total   = devs.length;

  let stateName;
  let text;
  if (!state.wsConnected) {
    stateName = "connecting";
    text = `Connecting… ${total} devices tracked`;
  } else {
    stateName = "live";
    const pausedFrag = paused ? `, ${paused} paused` : "";
    text = `Connected — ${online} of ${total} devices online${pausedFrag}`;
  }
  setLive(stateName);
  els.statusText.textContent = text;
}

// ── grouping ────────────────────────────────────────────────────────

function buildGroups() {
  // returns { people: Map<name, {devices, online, paused, todayBytes}>, household: [...], all }
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

  // sort: pinned people first alphabetically, then by device count
  const sortedPeople = [...people.values()].sort((a, b) => {
    if (b.devices.length !== a.devices.length) return b.devices.length - a.devices.length;
    return a.name.localeCompare(b.name);
  });
  // sort household by name
  household.sort((a, b) => (a.name || a.mac).localeCompare(b.name || b.mac));

  return { people: sortedPeople, household };
}

// ── people row ──────────────────────────────────────────────────────

function renderPeopleRow(people) {
  els.peopleRow.innerHTML = "";

  if (people.length === 0) {
    els.peopleEmpty.hidden = false;
    els.familySub.textContent = "No people yet — assign devices below to build your family.";
    return;
  }
  els.peopleEmpty.hidden = true;

  const totalOnline = people.reduce((a, p) => a + p.online, 0);
  const totalPaused = people.reduce((a, p) => a + p.paused, 0);
  els.familySub.textContent = totalPaused
    ? `${totalOnline} online · ${totalPaused} paused`
    : `${totalOnline} online right now`;

  for (const p of people) {
    const btn = document.createElement("button");
    btn.className = "person-card";
    btn.type = "button";
    btn.setAttribute("role", "listitem");
    btn.dataset.person = p.name;
    btn.setAttribute("aria-expanded", state.expandedPerson === p.name ? "true" : "false");

    const tone = toneFor(p.name);
    const beadState = p.paused ? "paused" : p.online ? "online" : "offline";

    const summary = buildPersonSummary(p);

    btn.innerHTML = `
      <div class="person-avatar" data-tone="${tone}">
        ${escapeHtml(initialsFor(p.name))}
        <span class="status-bead" data-state="${beadState}"></span>
      </div>
      <div>
        <h3 class="person-name">${escapeHtml(p.name)}</h3>
        <p class="person-summary">${summary}</p>
      </div>
    `;
    btn.addEventListener("click", () => togglePersonExpand(p.name));
    els.peopleRow.appendChild(btn);
  }
}

function buildPersonSummary(p) {
  const n = p.devices.length;
  const deviceWord = n === 1 ? "device" : "devices";
  if (p.paused) {
    return `${n} ${deviceWord} · <strong>${p.paused} paused</strong>`;
  }
  if (p.online === 0) {
    return `${n} ${deviceWord} · all offline`;
  }
  if (p.todayBytes > 0) {
    return `${n} ${deviceWord} · ${fmtBytesShort(p.todayBytes)} today`;
  }
  return `${n} ${deviceWord} · quiet today`;
}

// ── person groups (expandable inline) ──────────────────────────────

function renderPersonGroups(people) {
  els.personGroups.innerHTML = "";
  if (!state.expandedPerson) return;

  const p = people.find(x => x.name === state.expandedPerson);
  if (!p) {
    state.expandedPerson = null;
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "person-group";
  wrap.dataset.person = p.name;

  const sortedDevices = sortDevicesForDisplay(p.devices);

  wrap.innerHTML = `
    <div class="person-group-head">
      <h3 class="person-group-name">${escapeHtml(p.name)}'s devices</h3>
      <span class="person-group-meta">${p.devices.length} ${p.devices.length === 1 ? "device" : "devices"}</span>
    </div>
    <div class="device-grid" data-person-grid="${escapeHtml(p.name)}"></div>
  `;
  const grid = wrap.querySelector(".device-grid");
  for (const d of sortedDevices) {
    grid.appendChild(buildDeviceCard(d));
  }
  els.personGroups.appendChild(wrap);
}

function togglePersonExpand(name) {
  if (state.expandedPerson === name) {
    state.expandedPerson = null;
  } else {
    state.expandedPerson = name;
  }
  renderAll();
  // scroll the expanded group into view smoothly
  if (state.expandedPerson) {
    requestAnimationFrame(() => {
      const node = $(`.person-group[data-person="${CSS.escape(state.expandedPerson)}"]`);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

// ── household section ───────────────────────────────────────────────

function renderHousehold(household) {
  els.householdGrid.innerHTML = "";
  if (!household.length) {
    els.householdEmpty.hidden = false;
    els.householdSub.textContent = "Nothing here yet.";
    return;
  }
  els.householdEmpty.hidden = true;

  const online = household.filter(d => d.online).length;
  els.householdSub.textContent = `${household.length} ${household.length === 1 ? "device" : "devices"} · ${online} online`;

  for (const d of sortDevicesForDisplay(household)) {
    els.householdGrid.appendChild(buildDeviceCard(d));
  }
}

function sortDevicesForDisplay(arr) {
  return [...arr].sort((a, b) => {
    // paused first (so they're not lost), then online, then offline
    const weight = (d) => d.blocked ? 0 : d.online ? 1 : 2;
    const aw = weight(a), bw = weight(b);
    if (aw !== bw) return aw - bw;
    return (a.name || a.mac).localeCompare(b.name || b.mac);
  });
}

// ── device card ─────────────────────────────────────────────────────

const cardEls = new Map();         // mac -> card element (most recently rendered)
const countdownTimers = new Map(); // mac -> intervalId

function buildDeviceCard(d) {
  const card = els.cardTpl.content.firstElementChild.cloneNode(true);
  populateCard(card, d);
  cardEls.set(d.mac, card);
  return card;
}

function populateCard(card, d) {
  card.dataset.mac = d.mac;
  const cardState = d.blocked ? "paused" : d.online ? "online" : "offline";
  card.dataset.state = cardState;
  card.setAttribute("aria-label",
    `${d.name || d.mac}, ${cardState}`);

  // name + meta
  $('[data-bind="name"]',  card).textContent = d.name || d.hostname || d.mac;
  $('[data-bind="ip"]',    card).textContent = d.ip || "—";
  $('[data-bind="vendor"]',card).textContent = d.vendor || "Unknown device";

  // status pill
  const pill = $('[data-bind="statusPill"]', card);
  pill.dataset.state = cardState;
  pill.textContent = pillText(d);

  // activity line — story, not data
  $('[data-bind="activity"]', card).innerHTML = activityLine(d);

  // block button label
  const blockBtn = $('[data-bind="blockBtn"]', card);
  blockBtn.textContent = d.blocked ? "Resume" : "Pause";

  // assign button label
  const assignBtn = $('[data-bind="assignBtn"]', card);
  const currentOwner = guessOwner(d);
  assignBtn.textContent = currentOwner ? "Reassign…" : "Assign to person…";

  // countdown updates inline on the activity line (handled below)
  attachCountdown(card, d);

  // details panel population (only if open)
  const detailsOpen = state.expandedDetails.has(d.mac);
  const detailsEl = $('[data-bind="details"]', card);
  const toggleEl = $('[data-action="toggle-details"]', card);
  toggleEl.setAttribute("aria-expanded", detailsOpen ? "true" : "false");
  detailsEl.hidden = !detailsOpen;
  if (detailsOpen) populateDetails(card, d);

  // wire interactions (idempotent — clone replaces old node)
  card.addEventListener("click", onCardClick);
  card.addEventListener("keydown", onCardKey);
}

function pillText(d) {
  if (d.blocked) {
    if (d.block_expires) {
      const ms = new Date(d.block_expires).getTime() - Date.now();
      if (ms > 0) {
        const mins = Math.ceil(ms / 60000);
        if (mins < 60) return `Paused · ${mins} min left`;
        return `Paused · ${Math.floor(mins / 60)} h ${mins % 60} min`;
      }
    }
    return "Paused";
  }
  if (d.online) return "Online";
  return "Asleep";
}

function activityLine(d) {
  // Conversational, story-first.
  if (d.blocked) {
    if (d.block_expires) {
      const ms = new Date(d.block_expires).getTime() - Date.now();
      if (ms > 0) {
        const mins = Math.ceil(ms / 60000);
        return `Paused — resumes in ${humanMinutes(mins)}.`;
      }
    }
    return `Paused — no time limit set.`;
  }
  if (!d.online) {
    return `Asleep — last seen ${escapeHtml(fmtRelTime(d.last_seen))}.`;
  }

  // online — try to tell a story from destinations + bytes
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
  return `Quiet — connected but idle`;
}

function friendlyHostName(host) {
  if (!host) return "the web";
  // strip "www." and TLD for friendliness on top brands
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
  // domain only (drop subdomains beyond the last 2 labels)
  const parts = h.split(".");
  if (parts.length >= 2) h = parts.slice(-2).join(".");
  return h;
}

// ── details panel ───────────────────────────────────────────────────

function populateDetails(card, d) {
  $('[data-bind="dIp"]',       card).textContent = d.ip  || "—";
  $('[data-bind="dMac"]',      card).textContent = d.mac;
  $('[data-bind="dVendor"]',   card).textContent = d.vendor || "Unknown";
  $('[data-bind="dLastSeen"]', card).textContent = fmtRelTime(d.last_seen);
  $('[data-bind="dConns"]',    card).textContent = d.active_connections ?? 0;
  const totalDown = d.today_bytes_down || 0;
  const totalUp = d.today_bytes_up || 0;
  $('[data-bind="dToday"]',    card).textContent = `${fmtBytes(totalDown)} down · ${fmtBytes(totalUp)} up`;

  $('[data-bind="dests"]', card).innerHTML = renderDestList(d.top_destinations_today);
  $('[data-bind="spark"]', card).innerHTML = buildSparkline(d);
}

function renderDestList(dests) {
  if (!Array.isArray(dests) || dests.length === 0) {
    return `<li><span class="favicon">·</span><span class="host dim">No traffic recorded today</span><span></span></li>`;
  }
  return dests.slice(0, 5).map(d => `
    <li>
      ${faviconHTML(d.host)}
      <span class="host">${escapeHtml(friendlyHostName(d.host))}</span>
      <span class="bytes">${escapeHtml(fmtBytesShort(d.bytes))}</span>
    </li>
  `).join("");
}

function faviconHTML(host) {
  if (!host) return `<span class="favicon">?</span>`;
  const safe = String(host).replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (!safe) return `<span class="favicon">?</span>`;
  const initial = (safe.replace(/^www\./, "").charAt(0) || "?").toUpperCase();
  const url = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(safe)}`;
  return `<span class="favicon" data-initial="${escapeHtml(initial)}"><img src="${url}" alt="" loading="lazy" onerror="this.parentElement.textContent=this.parentElement.dataset.initial"></span>`;
}

function buildSparkline(device) {
  const total = (device.today_bytes_down || 0) + (device.today_bytes_up || 0);
  if (!total) {
    return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="42" x2="100" y2="42" stroke="rgba(31,29,26,0.08)" stroke-width="0.6" stroke-dasharray="2 2"/>
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
  const areaPath = `${linePath} L 100 44 L 0 44 Z`;
  const stroke = device.blocked ? "var(--coral)" : "var(--sage)";
  const fill   = device.blocked ? "rgba(209,122,107,0.12)" : "rgba(107,142,90,0.12)";

  return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
    <path d="${areaPath}" fill="${fill}"/>
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(2)}" cy="${pts[pts.length - 1][1].toFixed(2)}" r="1.6" fill="${stroke}"/>
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

function attachCountdown(card, d) {
  const prev = countdownTimers.get(d.mac);
  if (prev) { clearInterval(prev); countdownTimers.delete(d.mac); }

  if (!d.blocked || !d.block_expires) return;

  const id = setInterval(() => {
    const live = state.devices.get(d.mac);
    if (!live || !live.blocked || !live.block_expires) {
      clearInterval(id); countdownTimers.delete(d.mac); return;
    }
    // refresh the pill + activity line text — cheap
    const liveCard = cardEls.get(d.mac);
    if (!liveCard || !document.body.contains(liveCard)) {
      clearInterval(id); countdownTimers.delete(d.mac); return;
    }
    $('[data-bind="statusPill"]', liveCard).textContent = pillText(live);
    $('[data-bind="activity"]',   liveCard).innerHTML   = activityLine(live);
  }, 1000);
  countdownTimers.set(d.mac, id);
}

// ── card interactions ──────────────────────────────────────────────

function onCardKey(e) {
  if (e.key === "Enter" || e.key === " ") {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      toggleDetails(e.currentTarget);
    }
  }
}

function onCardClick(e) {
  const card = e.currentTarget;
  const mac = card.dataset.mac;
  const actionEl = e.target.closest("[data-action]");
  if (actionEl) {
    e.stopPropagation();
    const action = actionEl.dataset.action;
    if (action === "block")          return onPrimaryBlock(mac);
    if (action === "menu")           return toggleMenu(card);
    if (action === "rename")         return startRename(card, mac);
    if (action === "assign")         return openAssignModal(mac);
    if (action === "toggle-details") return toggleDetails(card);
    return;
  }
  const item = e.target.closest(".menu-item");
  if (item) {
    e.stopPropagation();
    closeAllMenus();
    return blockWithDuration(mac, item.dataset.mins);
  }
}

function toggleMenu(card) {
  const menu = $('[data-bind="menu"]', card);
  const trigger = $(".dropdown-trigger", card);
  const wasOpen = !menu.hidden;
  closeAllMenus();
  if (!wasOpen) {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
}

function closeAllMenus() {
  $$(".menu").forEach(m => m.hidden = true);
  $$(".dropdown-trigger").forEach(t => t.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu") && !e.target.closest(".dropdown-trigger")) closeAllMenus();
});

function toggleDetails(card) {
  const mac = card.dataset.mac;
  const open = state.expandedDetails.has(mac);
  const detailsEl = $('[data-bind="details"]', card);
  const toggle = $('[data-action="toggle-details"]', card);
  if (open) {
    state.expandedDetails.delete(mac);
    detailsEl.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  } else {
    state.expandedDetails.add(mac);
    const d = state.devices.get(mac);
    if (d) populateDetails(card, d);
    detailsEl.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  }
}

// ── rename (inline) ────────────────────────────────────────────────

function startRename(card, mac) {
  const nameEl = $('[data-bind="name"]', card);
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
    if (e.key === "Enter")  { e.preventDefault(); finish(true); }
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
  // default primary action: pause for 30 minutes (matches eero-style "quick pause")
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
    if (minutes) toast(`Paused ${friendly} for ${humanMinutes(minutes)}`);
    else toast(`Paused ${friendly}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderAll();
    toast(`Couldn't pause: ${err.message}`, "error");
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

  // existing people list
  const { people } = buildGroups();
  els.assignOptions.innerHTML = "";
  for (const p of people) {
    const btn = document.createElement("button");
    btn.className = "assign-option";
    btn.type = "button";
    btn.innerHTML = `
      <span class="person-avatar" data-tone="${toneFor(p.name)}">${escapeHtml(initialsFor(p.name))}</span>
      <span>${escapeHtml(p.name)}</span>
    `;
    btn.addEventListener("click", () => commitAssign(p.name));
    els.assignOptions.appendChild(btn);
  }
  if (!people.length) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:13px;color:var(--ink-3);margin:0 0 4px;";
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
  saveOwnerOverrides();
  closeAssignModal();
  renderAll();
  toast(`Assigned to ${name}`);

  // best-effort server sync. If the endpoint doesn't exist yet we silently
  // keep the local override and remember not to retry network calls.
  await persistOwner(mac, name).catch(err => {
    if (err.status === 404 || err.status === 405) {
      state.ownerEndpointAvailable = false;
      return;
    }
    state.ownerOverrides[mac] = prevOverride;
    saveOwnerOverrides();
    renderAll();
    toast(`Server didn't accept the assignment — kept locally only.`, "error");
  });
}

async function commitClearOwner() {
  const mac = state.pendingAssignMac;
  if (!mac) return;
  const prev = state.ownerOverrides[mac];
  state.ownerOverrides[mac] = "__household__";
  saveOwnerOverrides();
  closeAssignModal();
  renderAll();
  toast("Moved to Household devices");

  await persistOwner(mac, null).catch(err => {
    if (err.status === 404 || err.status === 405) {
      state.ownerEndpointAvailable = false;
      return;
    }
    state.ownerOverrides[mac] = prev;
    saveOwnerOverrides();
    renderAll();
  });
}

async function persistOwner(mac, owner) {
  if (!state.ownerEndpointAvailable) return;     // never tried? we still try once.
  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/owner`, { owner });
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      // endpoint not implemented yet — that's OK
      state.ownerEndpointAvailable = false;
      return;
    }
    throw err;
  }
}

// ── master render ──────────────────────────────────────────────────

function renderAll() {
  const { people, household } = buildGroups();
  renderPeopleRow(people);
  renderPersonGroups(people);
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
  // wire global UI
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

  // initial parallel fetch
  setLive("connecting");
  try {
    const [status, devices] = await Promise.all([
      jget(`${API}/status`).catch(() => null),
      jget(`${API}/devices`).catch(() => []),
    ]);
    state.status = status;
    if (Array.isArray(devices)) {
      for (const d of devices) state.devices.set(d.mac, d);
    }
    renderAll();
  } catch (err) {
    toast(`Couldn't load network: ${err.message}`, "error");
    renderAll();
  }

  connectWS();

  // soft refresh: re-render every 30s so "last seen" times stay current
  setInterval(() => renderAll(), 30_000);
}

document.addEventListener("DOMContentLoaded", boot);
