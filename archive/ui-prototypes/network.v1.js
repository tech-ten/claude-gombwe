// ════════════════════════════════════════════════════════════════════
// gombwe — network operator console
// Vanilla ES modules, no build step.
// ════════════════════════════════════════════════════════════════════

const API = "api/network";          // relative — served from /network
const WS_PATH = "ws";

// ── tiny utilities ──────────────────────────────────────────────────

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
  if (n < 1024) return `${n}B`;
  const units = ["K", "M", "G", "T"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return `${v.toFixed(dp)}${units[i]}`;
};

const fmtRelTime = (iso) => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10)    return "just now";
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

const escapeHtml = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// ── state ───────────────────────────────────────────────────────────

const state = {
  devices: new Map(),    // mac -> device
  status: null,
  filter: "all",
  sort: "bandwidth",
  search: "",
  selectedMac: null,
  wsConnected: false,
};

const els = {
  liveIndicator:   $("#liveIndicator"),
  routerInfo:      $("#routerInfo"),
  meterDown:       $("#meterDown"),
  meterUp:         $("#meterUp"),

  statOnline:      $("#statOnline"),
  statKnown:       $("#statKnown"),
  statOnlineFoot:  $("#statOnlineFoot"),
  statBlocked:     $("#statBlocked"),
  statBlockedFoot: $("#statBlockedFoot"),
  statDownTotal:   $("#statDownTotal"),
  statDownUnit:    $("#statDownUnit"),
  statUpTotal:     $("#statUpTotal"),
  statCollector:   $("#statCollector"),
  statCollectorFoot: $("#statCollectorFoot"),

  searchInput:     $("#searchInput"),
  sortSelect:      $("#sortSelect"),
  segBtns:         $$(".seg-btn"),
  cntAll:          $("#cntAll"),
  cntOnline:       $("#cntOnline"),
  cntBlocked:      $("#cntBlocked"),
  cntOffline:      $("#cntOffline"),

  grid:            $("#devices"),
  emptyState:      $("#emptyState"),
  cardTpl:         $("#tpl-card"),

  drawer:          $("#drawer"),
  drawerScrim:     $("#drawerScrim"),
  drawerClose:     $("#drawerClose"),
  drawerEyebrow:   $("#drawerEyebrow"),
  drawerTitle:     $("#drawerTitle"),
  drawerMeta:      $("#drawerMeta"),
  drawerChart:     $("#drawerChart"),
  drawerDests:     $("#drawerDests"),
  drawerEvents:    $("#drawerEvents"),

  toasts:          $("#toasts"),
};

// ── toast ───────────────────────────────────────────────────────────

const toast = (msg, kind = "ok", ms = 3200) => {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, ms);
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
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// ── live indicator ──────────────────────────────────────────────────

function setLive(stateName) {
  const el = els.liveIndicator;
  el.dataset.state = stateName;
  el.querySelector(".live-text").textContent =
    stateName === "live" ? "live" :
    stateName === "connecting" ? "connecting" :
    "offline";
}

// ── status render ───────────────────────────────────────────────────

function renderStatus(s) {
  state.status = s;
  if (!s) return;

  // router
  const r = s.router || {};
  els.routerInfo.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.dataset.bind;       // e.g. "router.model"
    const val = path.split(".").reduce((o, k) => (o == null ? null : o[k]), s);
    el.textContent = val ?? "—";
  });

  // meters
  const cb = s.current_bandwidth || {};
  els.meterDown.textContent = (cb.down_mbps ?? 0).toFixed(1);
  els.meterUp.textContent   = (cb.up_mbps ?? 0).toFixed(1);

  // hero
  els.statOnline.textContent = s.online_count ?? "—";
  els.statKnown.textContent  = s.known_count ?? "—";

  // collector
  const dc = s.data_collector || {};
  if (dc.running) {
    els.statCollector.textContent = "running";
    els.statCollector.style.color = "";
    const since = dc.first_snapshot ? `since ${fmtRelTime(dc.first_snapshot)}` : "first snapshot pending";
    const count = dc.snapshot_count != null ? `${dc.snapshot_count} snapshots · ` : "";
    els.statCollectorFoot.textContent = `${count}${since}`;
  } else {
    els.statCollector.textContent = "paused";
    els.statCollector.style.color = "var(--fg-3)";
    els.statCollectorFoot.textContent = "data collector is not running";
  }
}

function recomputeHeroFromDevices() {
  const devs = [...state.devices.values()];
  const online  = devs.filter(d => d.online).length;
  const blocked = devs.filter(d => d.blocked).length;
  const totalDown = devs.reduce((a, d) => a + (d.today_bytes_down || 0), 0);
  const totalUp   = devs.reduce((a, d) => a + (d.today_bytes_up   || 0), 0);

  // hero numbers (status endpoint already covers online_count, but devices may be authoritative)
  if (state.status) {
    els.statOnline.textContent = state.status.online_count ?? online;
    els.statKnown.textContent  = state.status.known_count ?? devs.length;
  } else {
    els.statOnline.textContent = online;
    els.statKnown.textContent  = devs.length;
  }
  els.statOnlineFoot.textContent = devs.length
    ? `${devs.length - online} offline · ${devs.length} total tracked`
    : "awaiting first snapshot";

  els.statBlocked.textContent = blocked;
  els.statBlockedFoot.textContent = blocked
    ? "active firewall rules in effect"
    : "no active firewall rules";

  // bytes split into (value, unit)
  const parts = fmtBytes(totalDown).split(" ");
  els.statDownTotal.textContent = parts[0];
  els.statDownUnit.textContent  = parts[1] || "B";
  els.statUpTotal.textContent   = fmtBytes(totalUp);

  // seg counts
  els.cntAll.textContent     = devs.length;
  els.cntOnline.textContent  = online;
  els.cntBlocked.textContent = blocked;
  els.cntOffline.textContent = devs.length - online;
}

// ── sparkline ───────────────────────────────────────────────────────

function buildSparkline(device) {
  // We don't have a series yet — derive a pseudo-series from cumulative bytes
  // distributed across 24 hourly buckets weighted by a smooth curve so the
  // card has visual life even before the activity endpoint lands.
  const totalDown = device.today_bytes_down || 0;
  const totalUp   = device.today_bytes_up   || 0;
  const N = 24;
  const series = device._series || makePseudoSeries(N, device.mac, totalDown);
  device._series = series;

  if (!totalDown && !totalUp) {
    return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="42" x2="100" y2="42" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2 2"/>
    </svg>`;
  }

  const max = Math.max(...series, 1);
  const pts = series.map((v, i) => {
    const x = (i / (N - 1)) * 100;
    const y = 42 - (v / max) * 38;
    return [x, y];
  });

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L 100 44 L 0 44 Z`;
  const stroke = device.blocked ? "var(--rose)" : device.online ? "var(--signal)" : "var(--fg-3)";
  const fill   = device.blocked ? "rgba(255,107,107,0.10)" : device.online ? "rgba(200,242,92,0.10)" : "rgba(255,255,255,0.04)";

  return `<svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
    <path d="${areaPath}" fill="${fill}"/>
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(2)}" cy="${pts[pts.length - 1][1].toFixed(2)}" r="1.6" fill="${stroke}"/>
  </svg>`;
}

// deterministic pseudo-series so cards don't flicker between renders
function makePseudoSeries(N, seed, total) {
  // hash mac to a seed
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619 >>> 0;
  const rng = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
  // smooth-ish weights
  const raw = Array.from({ length: N }, () => 0.4 + rng() * 0.6);
  // smooth pass
  for (let p = 0; p < 2; p++) {
    for (let i = 1; i < N - 1; i++) raw[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3;
  }
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map(v => Math.floor((v / sum) * (total || N * 1000)));
}

// ── destinations helpers ────────────────────────────────────────────

function faviconHTML(host) {
  if (!host) return `<span class="favicon">?</span>`;
  // We use Google's s2 favicon service. This is a soft assumption — if the
  // user wants fully offline, swap to a local proxy or initials only.
  const safeHost = String(host).replace(/[^a-zA-Z0-9.\-_]/g, "");
  if (!safeHost) return `<span class="favicon">?</span>`;
  const initial = (safeHost.replace(/^www\./, "").charAt(0) || "?").toUpperCase();
  const url = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(safeHost)}`;
  return `<span class="favicon" data-initial="${initial}"><img src="${url}" alt="" loading="lazy" onerror="this.parentElement.textContent=this.parentElement.dataset.initial"></span>`;
}

function renderDestList(dests, max = 3) {
  if (!Array.isArray(dests) || dests.length === 0) {
    return `<li><span class="favicon">∅</span><span class="host dim">no traffic recorded today</span><span></span></li>`;
  }
  return dests.slice(0, max).map(d => `
    <li>
      ${faviconHTML(d.host)}
      <span class="host">${escapeHtml(d.host)}</span>
      <span class="bytes">${fmtBytesShort(d.bytes)}</span>
    </li>
  `).join("");
}

// ── countdowns ──────────────────────────────────────────────────────

const countdownTimers = new Map();      // mac -> intervalId

function updateCountdownEl(el, expiresIso) {
  if (!expiresIso) { el.hidden = true; el.textContent = ""; return; }
  const ms = new Date(expiresIso).getTime() - Date.now();
  if (ms <= 0) { el.hidden = true; el.textContent = ""; return; }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  el.hidden = false;
  el.textContent = h > 0
    ? `unblocks in ${h}h ${String(m).padStart(2,"0")}m`
    : `unblocks in ${m}:${String(s).padStart(2,"0")}`;
}

function attachCountdown(card, device) {
  const el = card.querySelector('[data-bind="countdown"]');
  // clear any existing
  const prev = countdownTimers.get(device.mac);
  if (prev) { clearInterval(prev); countdownTimers.delete(device.mac); }

  if (!device.blocked || !device.block_expires) {
    el.hidden = true; el.textContent = "";
    return;
  }
  updateCountdownEl(el, device.block_expires);
  const id = setInterval(() => updateCountdownEl(el, device.block_expires), 1000);
  countdownTimers.set(device.mac, id);
}

// ── card render ─────────────────────────────────────────────────────

const cardEls = new Map();    // mac -> element

function renderCard(device) {
  const existing = cardEls.get(device.mac);
  const tpl = els.cardTpl.content.firstElementChild.cloneNode(true);
  populateCard(tpl, device);
  if (existing) {
    existing.replaceWith(tpl);
  }
  cardEls.set(device.mac, tpl);
  return tpl;
}

function populateCard(card, d) {
  card.dataset.mac = d.mac;
  card.dataset.blocked = String(!!d.blocked);
  card.dataset.offline = String(!d.online);
  card.setAttribute("aria-label", `${d.name || d.mac}, ${d.online ? "online" : "offline"}${d.blocked ? ", blocked" : ""}`);

  const dot = card.querySelector('[data-bind="dot"]');
  dot.dataset.state = d.blocked ? "blocked" : d.online ? "online" : "offline";

  card.querySelector('[data-bind="name"]').textContent = d.name || d.hostname || d.mac;
  card.querySelector('[data-bind="ip"]').textContent   = d.ip || "—";
  card.querySelector('[data-bind="mac"]').textContent  = d.mac;
  card.querySelector('[data-bind="vendor"]').textContent = d.vendor || "Unknown";

  const pill = card.querySelector('[data-bind="statusPill"]');
  if (d.blocked)      { pill.textContent = "blocked";  pill.dataset.state = "blocked"; }
  else if (d.online)  { pill.textContent = "online";   pill.dataset.state = "online"; }
  else                { pill.textContent = `seen ${fmtRelTime(d.last_seen)}`; pill.dataset.state = "offline"; }

  card.querySelector('[data-bind="todayDown"]').textContent = fmtBytesShort(d.today_bytes_down || 0);
  card.querySelector('[data-bind="todayUp"]').textContent   = fmtBytesShort(d.today_bytes_up || 0);
  card.querySelector('[data-bind="connections"]').textContent = d.active_connections ?? 0;

  card.querySelector('[data-bind="spark"]').innerHTML = buildSparkline(d);
  card.querySelector('[data-bind="dests"]').innerHTML = renderDestList(d.top_destinations_today);

  const primary = card.querySelector('[data-action="block"]');
  primary.textContent = d.blocked ? "unblock" : "block";

  attachCountdown(card, d);

  // ── interactions ──
  card.addEventListener("click", onCardClick);
  card.addEventListener("keydown", onCardKey);
}

function onCardKey(e) {
  if (e.key === "Enter" || e.key === " ") {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      openDrawer(e.currentTarget.dataset.mac);
    }
  }
}

function onCardClick(e) {
  const card = e.currentTarget;
  const mac = card.dataset.mac;
  const t = e.target.closest("[data-action]");
  if (t) {
    e.stopPropagation();
    const action = t.dataset.action;
    if (action === "block") return onPrimaryBlock(mac);
    if (action === "menu")  return toggleMenu(card);
    if (action === "rename") return startRename(card, mac);
    return;
  }
  // menu item?
  const item = e.target.closest(".menu-item");
  if (item) {
    e.stopPropagation();
    const v = item.dataset.mins;
    closeAllMenus();
    return blockWithDuration(mac, v);
  }
  // otherwise open the drawer
  openDrawer(mac);
}

function toggleMenu(card) {
  const menu = card.querySelector('[data-bind="menu"]');
  const trigger = card.querySelector(".menu-trigger");
  const open = !menu.hidden;
  closeAllMenus();
  if (!open) {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
}
function closeAllMenus() {
  $$(".menu").forEach(m => m.hidden = true);
  $$(".menu-trigger").forEach(t => t.setAttribute("aria-expanded", "false"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu") && !e.target.closest(".menu-trigger")) closeAllMenus();
});

// ── rename (inline) ─────────────────────────────────────────────────

function startRename(card, mac) {
  const nameEl = card.querySelector('[data-bind="name"]');
  if (nameEl.classList.contains("editing")) return;
  const old = nameEl.textContent;
  nameEl.classList.add("editing");
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.focus();
  // select all
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
    d.name = v;                              // optimistic
    try {
      await jpost(`${API}/devices/${encodeURIComponent(mac)}/name`, { name: v });
      toast(`renamed to ${v}`);
    } catch (err) {
      d.name = prev;
      nameEl.textContent = prev;
      toast(`rename failed: ${err.message}`, "error");
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  nameEl.addEventListener("keydown", onKey);
  nameEl.addEventListener("blur", onBlur);
}

// ── block / unblock ─────────────────────────────────────────────────

async function onPrimaryBlock(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  if (d.blocked) return unblockDevice(mac);
  return blockWithDuration(mac, "0");      // indefinite when using primary button
}

function durationToMinutes(spec) {
  if (spec === "until_tomorrow") {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    return Math.max(1, Math.floor((t.getTime() - Date.now()) / 60000));
  }
  const n = parseInt(spec, 10);
  if (isNaN(n) || n <= 0) return null;     // indefinite
  return n;
}

async function blockWithDuration(mac, spec) {
  const d = state.devices.get(mac);
  if (!d) return;
  const minutes = durationToMinutes(spec);

  // optimistic
  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = true;
  d.block_expires = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  renderCardInPlace(d);
  recomputeHeroFromDevices();
  applyFilter();

  try {
    const res = await jpost(`${API}/devices/${encodeURIComponent(mac)}/block`,
      minutes ? { duration_minutes: minutes } : {});
    // trust server's expiry if returned
    if (res?.blocked_until !== undefined) d.block_expires = res.blocked_until;
    renderCardInPlace(d);
    toast(`blocked ${d.name || mac}${minutes ? ` for ${humanMinutes(minutes)}` : ""}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderCardInPlace(d);
    recomputeHeroFromDevices();
    applyFilter();
    toast(`block failed: ${err.message}`, "error");
  }
}

async function unblockDevice(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  const prev = { blocked: d.blocked, block_expires: d.block_expires };
  d.blocked = false;
  d.block_expires = null;
  renderCardInPlace(d);
  recomputeHeroFromDevices();
  applyFilter();

  try {
    await jpost(`${API}/devices/${encodeURIComponent(mac)}/unblock`);
    toast(`unblocked ${d.name || mac}`);
  } catch (err) {
    d.blocked = prev.blocked;
    d.block_expires = prev.block_expires;
    renderCardInPlace(d);
    recomputeHeroFromDevices();
    applyFilter();
    toast(`unblock failed: ${err.message}`, "error");
  }
}

function humanMinutes(m) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function renderCardInPlace(device) {
  const existing = cardEls.get(device.mac);
  if (!existing) return;
  // re-populate fields without rebuilding the element, to preserve focus & avoid flicker
  populateCard(existing, device);
}

// ── grid render & filtering ─────────────────────────────────────────

function fullRender() {
  els.grid.setAttribute("aria-busy", "false");
  els.grid.innerHTML = "";
  cardEls.clear();
  const list = sortedFilteredDevices();
  if (!list.length) {
    els.emptyState.hidden = false;
    return;
  }
  els.emptyState.hidden = true;
  const frag = document.createDocumentFragment();
  list.forEach((d, i) => {
    const card = els.cardTpl.content.firstElementChild.cloneNode(true);
    populateCard(card, d);
    card.style.animationDelay = `${Math.min(i, 16) * 24}ms`;
    cardEls.set(d.mac, card);
    frag.appendChild(card);
  });
  els.grid.appendChild(frag);
}

function applyFilter() {
  // re-evaluate filter visibility on existing cards
  const list = sortedFilteredDevices();
  const visibleMacs = new Set(list.map(d => d.mac));

  // remove cards for devices not in list, append new ones
  [...cardEls.entries()].forEach(([mac, el]) => {
    if (!visibleMacs.has(mac)) { el.remove(); cardEls.delete(mac); }
  });

  // re-order + insert missing
  const frag = document.createDocumentFragment();
  list.forEach((d, i) => {
    let el = cardEls.get(d.mac);
    if (!el) {
      el = els.cardTpl.content.firstElementChild.cloneNode(true);
      populateCard(el, d);
      el.style.animationDelay = `${Math.min(i, 16) * 24}ms`;
      cardEls.set(d.mac, el);
    }
    frag.appendChild(el);  // appending an in-DOM node moves it
  });
  els.grid.appendChild(frag);
  els.emptyState.hidden = list.length > 0;
}

function sortedFilteredDevices() {
  const q = state.search.trim().toLowerCase();
  let list = [...state.devices.values()].filter(d => {
    if (state.filter === "online"  && !d.online)  return false;
    if (state.filter === "blocked" && !d.blocked) return false;
    if (state.filter === "offline" && d.online)   return false;
    if (!q) return true;
    return (
      (d.name     && d.name.toLowerCase().includes(q)) ||
      (d.hostname && d.hostname.toLowerCase().includes(q)) ||
      (d.ip       && d.ip.toLowerCase().includes(q)) ||
      (d.mac      && d.mac.toLowerCase().includes(q)) ||
      (d.vendor   && d.vendor.toLowerCase().includes(q))
    );
  });

  const cmp = {
    bandwidth:   (a, b) => (b.today_bytes_down || 0) - (a.today_bytes_down || 0),
    connections: (a, b) => (b.active_connections || 0) - (a.active_connections || 0),
    name:        (a, b) => (a.name || a.mac).localeCompare(b.name || b.mac),
    lastseen:    (a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0),
  }[state.sort];

  // blocked sinks above offline; online floats
  list.sort((a, b) => {
    const aw = (a.online ? 0 : 1) + (a.blocked ? -0.5 : 0);
    const bw = (b.online ? 0 : 1) + (b.blocked ? -0.5 : 0);
    if (aw !== bw) return aw - bw;
    return cmp(a, b);
  });
  return list;
}

// ── drawer ──────────────────────────────────────────────────────────

let drawerActivityCtrl = null;

async function openDrawer(mac) {
  const d = state.devices.get(mac);
  if (!d) return;
  state.selectedMac = mac;

  els.drawerEyebrow.textContent = `${d.vendor || "device"} · ${d.online ? "online" : "offline"}${d.blocked ? " · blocked" : ""}`;
  els.drawerTitle.textContent   = d.name || d.hostname || d.mac;
  els.drawerMeta.textContent    = `${d.ip || "—"} · ${d.mac} · last seen ${fmtRelTime(d.last_seen)}`;
  els.drawerDests.innerHTML     = renderDrawerDests(d.top_destinations_today);
  els.drawerEvents.innerHTML    = `<li class="event-empty">loading…</li>`;
  els.drawerChart.innerHTML     = renderEmptyChart();

  els.drawer.setAttribute("aria-hidden", "false");
  els.drawerScrim.hidden = false;
  document.body.style.overflow = "hidden";
  els.drawer.focus();

  // fetch activity series — best-effort. If endpoint isn't ready, fail gracefully.
  if (drawerActivityCtrl) drawerActivityCtrl.abort();
  drawerActivityCtrl = new AbortController();
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = await fetch(`${API}/activity?device=${encodeURIComponent(mac)}&since=${encodeURIComponent(since)}`, {
      signal: drawerActivityCtrl.signal,
      headers: { accept: "application/json" },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const series = await r.json();
    renderDrawerActivity(series);
  } catch (err) {
    if (err.name === "AbortError") return;
    // soft fallback — synthesize from device.today_bytes_*
    renderDrawerActivity({ events: [], buckets: d._series || makePseudoSeries(48, d.mac, d.today_bytes_down || 0) });
  }
}

function closeDrawer() {
  els.drawer.setAttribute("aria-hidden", "true");
  els.drawerScrim.hidden = true;
  document.body.style.overflow = "";
  state.selectedMac = null;
}

function renderDrawerDests(dests) {
  if (!Array.isArray(dests) || !dests.length) {
    return `<li><span></span><span class="favicon">∅</span><span class="host dim">no traffic recorded today</span><span></span><span></span></li>`;
  }
  return dests.map(d => `
    <li>
      ${faviconHTML(d.host)}
      <span class="host">${escapeHtml(d.host)}</span>
      <span class="conns">${d.connections ?? 0} conns</span>
      <span class="bytes">${fmtBytes(d.bytes)}</span>
    </li>
  `).join("");
}

function renderEmptyChart() {
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none">
    <line x1="0" y1="38" x2="100" y2="38" stroke="var(--line)" stroke-width="0.4" stroke-dasharray="2 2"/>
  </svg>`;
}

/**
 * Accept either:
 *   { events: [{ts, host, bytes_down, bytes_up}], buckets: [n…] }
 * OR a raw array (which we'll treat as bucketed down values).
 * This is an intentionally loose contract — backend hasn't finalised yet.
 */
function renderDrawerActivity(payload) {
  let down = [], up = [], events = [];
  if (Array.isArray(payload)) {
    down = payload;
  } else if (payload && typeof payload === "object") {
    events = payload.events || [];
    down   = payload.down_buckets || payload.buckets || (events.length ? bucketize(events, "bytes_down") : []);
    up     = payload.up_buckets   || (events.length ? bucketize(events, "bytes_up") : []);
  }

  els.drawerChart.innerHTML = drawDualLineChart(down, up);

  if (!events.length) {
    els.drawerEvents.innerHTML = `<li class="event-empty">no recent connections recorded</li>`;
  } else {
    els.drawerEvents.innerHTML = events.slice(0, 80).map(e => `
      <li>
        <span class="ts">${fmtTime(e.ts || e.timestamp)}</span>
        <span class="host">${escapeHtml(e.host || e.destination || "—")}</span>
        <span class="bytes">${fmtBytesShort((e.bytes_down || 0) + (e.bytes_up || 0))}</span>
      </li>
    `).join("");
  }
}

function bucketize(events, field, N = 48) {
  if (!events.length) return Array(N).fill(0);
  const now = Date.now();
  const span = 24 * 3600_000;
  const buckets = Array(N).fill(0);
  for (const e of events) {
    const t = new Date(e.ts || e.timestamp).getTime();
    if (isNaN(t)) continue;
    const i = Math.min(N - 1, Math.max(0, Math.floor(((t - (now - span)) / span) * N)));
    buckets[i] += e[field] || 0;
  }
  return buckets;
}

function drawDualLineChart(down, up) {
  const N = Math.max(down.length, up.length, 1);
  if (!N || (!down.some(v => v) && !up.some(v => v))) return renderEmptyChart();

  const max = Math.max(...down, ...up, 1);
  const mkPath = (arr) => {
    if (!arr.length) return "";
    return arr.map((v, i) => {
      const x = (i / (N - 1)) * 100;
      const y = 38 - (v / max) * 34;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
  };
  const downPath = mkPath(down);
  const upPath   = mkPath(up);

  return `
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      ${downPath ? `<path d="${downPath} L 100 40 L 0 40 Z" fill="rgba(107,184,255,0.10)"/>` : ""}
      ${downPath ? `<path d="${downPath}" fill="none" stroke="var(--sky)" stroke-width="0.9" stroke-linejoin="round"/>` : ""}
      ${upPath   ? `<path d="${upPath}"   fill="none" stroke="var(--amber)" stroke-width="0.9" stroke-linejoin="round" stroke-dasharray="0.6 0.6"/>` : ""}
    </svg>
  `;
}

// ── WebSocket ───────────────────────────────────────────────────────

let ws = null;
let wsAttempts = 0;
let wsReconnectTimer = null;

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/${WS_PATH}`;
}

function connectWS() {
  setLive("connecting");
  try { ws = new WebSocket(wsUrl()); }
  catch (e) { scheduleReconnect(); return; }

  ws.addEventListener("open", () => {
    state.wsConnected = true;
    wsAttempts = 0;
    setLive("live");
  });

  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleWSEvent(msg);
  });

  ws.addEventListener("close", () => {
    state.wsConnected = false;
    setLive("offline");
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
    const { mac, ...rest } = msg;
    if (!mac) return;
    const prev = state.devices.get(mac) || { mac };
    const next = { ...prev, ...rest, mac };
    state.devices.set(mac, next);
    if (cardEls.has(mac)) renderCardInPlace(next);
    else applyFilter();           // it's new — pull into the grid
    recomputeHeroFromDevices();
    // if drawer open for this device, refresh light fields
    if (state.selectedMac === mac) {
      els.drawerEyebrow.textContent = `${next.vendor || "device"} · ${next.online ? "online" : "offline"}${next.blocked ? " · blocked" : ""}`;
      els.drawerMeta.textContent = `${next.ip || "—"} · ${next.mac} · last seen ${fmtRelTime(next.last_seen)}`;
    }
  } else if (msg.type === "network:status:update") {
    state.status = { ...(state.status || {}), ...msg };
    renderStatus(state.status);
  } else if (msg.type === "network:device:remove") {
    state.devices.delete(msg.mac);
    const el = cardEls.get(msg.mac);
    if (el) { el.remove(); cardEls.delete(msg.mac); }
    recomputeHeroFromDevices();
  }
}

// ── boot ────────────────────────────────────────────────────────────

async function boot() {
  // wire global UI listeners first so the page is responsive even while loading
  els.searchInput.addEventListener("input", debounce((e) => {
    state.search = e.target.value;
    applyFilter();
  }, 80));

  els.sortSelect.addEventListener("change", (e) => {
    state.sort = e.target.value;
    applyFilter();
  });

  els.segBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      els.segBtns.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      state.filter = btn.dataset.filter;
      applyFilter();
    });
  });

  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerScrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.selectedMac) closeDrawer();
      else closeAllMenus();
    } else if (e.key === "/" && document.activeElement !== els.searchInput) {
      const tag = document.activeElement?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        els.searchInput.focus();
      }
    }
  });

  // initial parallel fetch
  setLive("connecting");
  try {
    const [status, devices] = await Promise.all([
      jget(`${API}/status`).catch(() => null),
      jget(`${API}/devices`).catch(() => []),
    ]);
    if (status) renderStatus(status);
    if (Array.isArray(devices)) {
      devices.forEach(d => state.devices.set(d.mac, d));
    }
    recomputeHeroFromDevices();
    fullRender();
  } catch (err) {
    toast(`failed to load: ${err.message}`, "error");
    els.grid.innerHTML = "";
    els.emptyState.hidden = false;
  }

  // subscribe to WS for live updates
  connectWS();

  // soft refresh router uptime label every 30s using last-seen timestamps
  setInterval(() => {
    // re-render offline pills (which show "seen Xs ago")
    [...cardEls.entries()].forEach(([mac, el]) => {
      const d = state.devices.get(mac);
      if (!d || d.online || d.blocked) return;
      const pill = el.querySelector('[data-bind="statusPill"]');
      if (pill) pill.textContent = `seen ${fmtRelTime(d.last_seen)}`;
    });
  }, 30_000);
}

document.addEventListener("DOMContentLoaded", boot);
