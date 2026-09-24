// Prahari officer console — talks to the FastAPI backend.
// When this page is served from the same origin as the API (Render, or local dev)
// we use relative paths. When it is served from a different origin (e.g. the
// Vercel-hosted frontend) we point at the Render backend directly.
const BACKEND_ORIGIN = "https://prahari-mhqy.onrender.com";
const _sameOrigin = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ||
  location.origin === BACKEND_ORIGIN;
const API = _sameOrigin ? "" : BACKEND_ORIGIN;

// Tier = status, so every use pairs the colour with a glyph and a label.
const TIERS = {
  "High-Confidence": { key: "high", short: "High", glyph: "◆", color: "#5FAE7A", rank: 0 },
  "Corroborated":    { key: "corr", short: "Corroborated", glyph: "▲", color: "#E08E45", rank: 1 },
  "Unverified":      { key: "unv",  short: "Unverified", glyph: "○", color: "#D9536F", rank: 2 },
};
const tierOf = (t) => TIERS[t] || TIERS.Unverified;
const RISK_RANK = { elevated: 0, watch: 1, normal: 2 };
const RISK_COLOR = { elevated: "#D9536F", watch: "#E08E45", normal: "#5FAE7A" };
const REFRESH_MS = 15000;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

const state = {
  incidents: [], reports: [], chain: [], chainStatus: null, zones: [],
  reportById: new Map(),
  known: new Map(),          // incident_id -> tier, for new/escalation detection
  newIds: new Set(),
  freshSeqs: new Set(),
  selectedId: null,
  detail: null,              // { id, data }
  detailTab: "overview",
  filter: new Set(Object.keys(TIERS)),
  query: "",
  sort: store.get("prahari.sort", "priority"),
  auto: store.get("prahari.live", true),
  showZones: store.get("prahari.zones", true),
  loaded: false, loading: false, online: null,
  lastUpdated: null, latency: null, fitted: false,
  lastReporter: null, timer: null,
  sig: {},
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/* ------------------------------------------------------------------ API -- */
let inflight = 0;
let wakeTimer = null;

async function api(path, opts = {}) {
  inflight++;
  if (!wakeTimer) wakeTimer = setTimeout(() => setWaking(true), 2500);
  const t0 = performance.now();
  try {
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new ApiError((data && data.detail) || text || res.statusText, res.status);
    state.latency = Math.round(performance.now() - t0);
    setOnline(true);
    return data;
  } catch (e) {
    if (!(e instanceof ApiError)) setOnline(false);
    throw e;
  } finally {
    if (--inflight === 0) { clearTimeout(wakeTimer); wakeTimer = null; setWaking(false); }
  }
}

const postJSON = (path, body) => api(path, {
  method: "POST",
  headers: body ? { "Content-Type": "application/json" } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

function setWaking(on) {
  $("#wakeBanner").hidden = !on;
  if (on) setPill("waking", "Waking API…");
}

function setOnline(ok) {
  const was = state.online;
  state.online = ok;
  if (ok) setPill("online", `Online · ${state.latency ?? "–"} ms`);
  else {
    setPill("offline", "Offline");
    if (was === true) toast("error", "Lost connection to the API", "Retrying automatically while Live is on.");
  }
  if (ok && was === false) toast("success", "Reconnected", "The evidence API is reachable again.");
}

function setPill(stateName, label) {
  const pill = $("#apiStatus");
  pill.dataset.state = stateName;
  $(".label", pill).textContent = label;
}

/* --------------------------------------------------------------- helpers -- */
function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

function membersOf(inc) {
  return (inc.report_ids || []).map((id) => state.reportById.get(id)).filter(Boolean);
}
function reporterCount(inc) {
  const refs = new Set(membersOf(inc).map((r) => r.reporter_ref || r.id));
  return refs.size || inc.report_count;
}
function zoneLabel(inc) {
  if (inc.zone_name) return inc.zone_name;
  const lm = membersOf(inc).map((r) => r.landmark).find(Boolean);
  if (lm) return lm;
  return `${Number(inc.lat).toFixed(4)}, ${Number(inc.lon).toFixed(4)}`;
}
function parsePayload(entry) {
  try { return JSON.parse(entry.payload); } catch (e) { return {}; }
}

// Latest ledger entry for an incident, and whether it still matches the live verdict.
function sealInfo(inc) {
  let entry = null;
  for (const e of state.chain) if (e.incident_id === inc.incident_id) entry = e;
  if (!entry) return null;
  const payload = parsePayload(entry);
  const st = state.chainStatus;
  const broken = !!(st && !st.valid && st.broken_at != null && entry.seq >= st.broken_at);
  const changed = payload.tier !== inc.tier || payload.report_count !== inc.report_count;
  return { entry, payload, seq: entry.seq, broken, changed };
}

function sealBadge(seal) {
  if (!seal) return "";
  if (seal.broken) return `<span class="badge bad">${icon("i-shield-x")}Seal #${seal.seq} broken</span>`;
  if (seal.changed) return `<span class="badge warn">${icon("i-alert")}Changed since seal #${seal.seq}</span>`;
  return `<span class="badge ok">${icon("i-lock")}Sealed #${seal.seq}</span>`;
}

function tierPill(tier) {
  const t = TIERS[tier];
  if (!t) return `<span class="pill t-unv"><span aria-hidden="true">✗</span>${esc(tier || "unknown")}</span>`;
  return `<span class="pill t-${t.key}"><span aria-hidden="true">${t.glyph}</span>${t.short}</span>`;
}

function setBtnLoading(btn, on) {
  if (!btn) return;
  const use = $("use", btn);
  if (on) {
    if (use && !btn.dataset.icon) { btn.dataset.icon = use.getAttribute("href"); use.setAttribute("href", "#i-refresh"); }
  } else if (use && btn.dataset.icon) {
    use.setAttribute("href", btn.dataset.icon); delete btn.dataset.icon;
  }
  btn.classList.toggle("is-loading", on);
  btn.disabled = on;
}

function countUp(el, to) {
  const from = Number(el.dataset.value) || 0;
  const first = el.textContent.trim() === "—";
  el.dataset.value = to;
  if (REDUCED || (from === to && !first)) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 650;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(() => { if (Number(el.dataset.value) === to) el.textContent = to; }, dur + 80);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

/* ---------------------------------------------------------------- toasts -- */
function toast(type, title, msg = "", ms = 4800) {
  const icons = { success: "i-check", warn: "i-alert", error: "i-alert", info: "i-info" };
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `${icon(icons[type] || "i-info")}<div><b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ""}</div>`;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ------------------------------------------------------------------- map -- */
let map, zoneLayer, markerLayer, ringLayer;
const markerById = new Map();

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([19.05, 72.86], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  zoneLayer = L.layerGroup();
  if (state.showZones) zoneLayer.addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  ringLayer = L.layerGroup().addTo(map);

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "map-legend");
    d.innerHTML = Object.entries(TIERS).map(([name, t]) =>
      `<div><span class="glyph" style="color:${t.color}">${t.glyph}</span>${name}</div>`).join("") +
      `<div><span class="dash"></span> ambient risk zone</div>`;
    return d;
  };
  legend.addTo(map);
  window.addEventListener("resize", () => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 400);
}

function renderZones() {
  const sig = JSON.stringify(state.zones.map((z) => z.zone_id));
  if (sig === state.sig.zones) return;
  state.sig.zones = sig;
  zoneLayer.clearLayers();
  state.zones.forEach((z) => {
    const c = RISK_COLOR[z.risk_level] || "#8FAE97";
    L.circle([z.lat, z.lon], {
      radius: 2000, color: c, weight: 1.2, dashArray: "6 6", fillColor: c, fillOpacity: 0.05, interactive: true,
    }).bindTooltip(`${esc(z.zone_name)} · ${esc(z.risk_level)} · ${z.rainfall_mm_last_3h} mm/3h`, { sticky: true })
      .addTo(zoneLayer);
  });
}

function renderMarkers() {
  const list = visibleIncidents();
  const sig = JSON.stringify(list.map((i) => [i.incident_id, i.tier, i.report_count]));
  if (sig !== state.sig.markers) {
    state.sig.markers = sig;
    markerLayer.clearLayers();
    markerById.clear();
    list.forEach((i) => {
      if (i.lat == null || i.lon == null) return;
      const t = tierOf(i.tier);
      const m = L.circleMarker([i.lat, i.lon], {
        radius: 7 + Math.min(i.report_count, 12) * 1.3,
        color: t.color, fillColor: t.color,
        fillOpacity: t.key === "unv" ? 0.3 : 0.55,
        weight: 2,
        dashArray: t.key === "unv" ? "3 3" : null,
        className: t.key === "high" ? "mk-high" : "",
      }).addTo(markerLayer);
      m.bindTooltip(`${t.glyph} ${esc(zoneLabel(i))} — ${esc(i.tier)} · ${plural(i.report_count, "report")}`, { direction: "top", offset: [0, -6] });
      m.on("click", () => select(i.incident_id, { pan: false }));
      markerById.set(i.incident_id, m);
    });
  }
  renderRing();
}

function renderRing() {
  ringLayer.clearLayers();
  const m = markerById.get(state.selectedId);
  if (!m) return;
  L.circleMarker(m.getLatLng(), {
    radius: m.getRadius() + 7, color: "#E08E45", weight: 2, fill: false, interactive: false, className: "mk-ring",
  }).addTo(ringLayer);
}

function fitToIncidents(animate = true) {
  const pts = visibleIncidents().filter((i) => i.lat != null).map((i) => [i.lat, i.lon]);
  const all = pts.length ? pts : state.zones.map((z) => [z.lat, z.lon]);
  if (!all.length) return;
  if (all.length === 1) map.setView(all[0], 14, { animate });
  else map.fitBounds(L.latLngBounds(all).pad(0.25), { animate, maxZoom: 14 });
}

/* ------------------------------------------------------------------ KPIs -- */
function renderKpis() {
  const inc = state.incidents;
  const n = { "High-Confidence": 0, "Corroborated": 0, "Unverified": 0 };
  inc.forEach((i) => { if (i.tier in n) n[i.tier]++; });
  countUp($("#kpiIncidents"), inc.length);
  countUp($("#kpiHigh"), n["High-Confidence"]);
  countUp($("#kpiCorr"), n["Corroborated"]);
  countUp($("#kpiUnv"), n["Unverified"]);

  const tierSig = JSON.stringify(n);
  if (tierSig !== state.sig.tierbar) {
    state.sig.tierbar = tierSig;
    const bar = $("#tierBar");
    bar.innerHTML = inc.length
      ? Object.entries(TIERS).filter(([name]) => n[name]).map(([name, t]) =>
        `<span class="s-${t.key}" style="flex:${n[name]}" title="${n[name]} ${name}"></span>`).join("")
      : "";
    bar.setAttribute("aria-label", `Incidents by tier: ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    $("#tierLegend").innerHTML = Object.entries(TIERS).map(([name, t]) =>
      `<span><span class="glyph" style="color:${t.color}">${t.glyph}</span>${n[name]} ${t.short}</span>`).join("");
  }

  const reps = state.reports;
  countUp($("#kpiReports"), reps.length);
  const wa = reps.filter((r) => r.channel === "whatsapp").length;
  $("#kpiChannels").textContent = reps.length ? `WhatsApp ${wa} · SMS ${reps.length - wa}` : "";
  const bystanders = new Set(reps.map((r) => r.reporter_ref || r.id)).size;
  $("#kpiReporters").textContent = reps.length
    ? `${plural(bystanders, "independent bystander")} · last 60 min shown`
    : "last 60 minutes, 5-minute bins";
  renderActivity();

  const st = state.chainStatus;
  const tile = $("#kpiLedgerTile");
  countUp($("#kpiLedger"), state.chain.length);
  tile.classList.toggle("is-good", !!(st && st.valid && state.chain.length));
  tile.classList.toggle("is-bad", !!(st && !st.valid));
  $("#kpiLedgerState").innerHTML = !st || !state.chain.length
    ? "empty — seal an incident"
    : st.valid ? `${icon("i-shield")}chain intact` : `${icon("i-shield-x")}broken at entry #${st.broken_at}`;
}

// Reports per 5-minute bin over the last hour — one series, one hue, hover for exact values.
function renderActivity() {
  const el = $("#activityChart");
  const bins = 12, span = 5 * 60 * 1000, now = Date.now();
  const counts = new Array(bins).fill(0);
  state.reports.forEach((r) => {
    const age = now - new Date(r.created_at).getTime();
    const idx = bins - 1 - Math.floor(age / span);
    if (age >= 0 && idx >= 0 && idx < bins) counts[idx]++;
  });
  const w = Math.max(80, el.clientWidth || 160), h = 44, base = h - 11, gap = 2;
  const sig = JSON.stringify([counts, w]);
  if (sig === state.sig.activity) return;
  state.sig.activity = sig;
  const max = Math.max(1, ...counts);
  const bw = (w - gap * (bins - 1)) / bins;
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Reports per 5 minutes, last hour: ${counts.join(", ")}">`;
  counts.forEach((c, i) => {
    const x = i * (bw + gap);
    const bh = c ? Math.max(3, (c / max) * (base - 2)) : 2;
    const y = base - bh, r = Math.min(3, bw / 2, bh);
    const start = new Date(now - (bins - i) * span), end = new Date(now - (bins - 1 - i) * span);
    svg += `<rect class="hit" x="${x}" y="0" width="${bw + gap}" height="${base}" data-tip="${clock(start.toISOString())}–${clock(end.toISOString())}" data-count="${c}"/>`;
    svg += `<path class="bar${c ? "" : " empty"}" style="animation-delay:${i * 25}ms" d="M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z"/>`;
  });
  svg += `<text class="axis" x="0" y="${h - 1}">−60m</text><text class="axis" x="${w}" y="${h - 1}" text-anchor="end">now</text></svg>`;
  el.innerHTML = svg;
}

function bindChartTip() {
  const tip = $("#chartTip");
  const chart = $("#activityChart");
  chart.addEventListener("mouseover", (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) return;
    const c = Number(hit.dataset.count);
    tip.innerHTML = `${esc(hit.dataset.tip)} · <b>${plural(c, "report")}</b>`;
    const r = hit.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top + 4}px`;
    tip.hidden = false;
    $$(".bar", chart).forEach((b) => b.classList.remove("hover"));
    hit.nextElementSibling?.classList.add("hover");
  });
  chart.addEventListener("mouseleave", () => {
    tip.hidden = true;
    $$(".bar", chart).forEach((b) => b.classList.remove("hover"));
  });
}

/* ------------------------------------------------------------------ feed -- */
function visibleIncidents() {
  const q = state.query.trim().toLowerCase();
  let list = state.incidents.filter((i) => state.filter.has(i.tier));
  if (q) {
    list = list.filter((i) => [zoneLabel(i), i.tier, i.ambient_detail?.zone_name,
      ...membersOf(i).map((r) => r.landmark)].join(" ").toLowerCase().includes(q));
  }
  const priority = (a, b) =>
    tierOf(a.tier).rank - tierOf(b.tier).rank ||
    (b.ambient_flagged - a.ambient_flagged) ||
    b.report_count - a.report_count ||
    String(b.last_seen).localeCompare(String(a.last_seen));
  const sorters = {
    priority,
    reports: (a, b) => b.report_count - a.report_count || priority(a, b),
    recent: (a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || priority(a, b),
  };
  return list.sort(sorters[state.sort] || priority);
}

function renderFilterChips() {
  const n = {};
  state.incidents.forEach((i) => { n[i.tier] = (n[i.tier] || 0) + 1; });
  $$(".fchip").forEach((b) => {
    $("b", b).textContent = n[b.dataset.tier] || 0;
    b.setAttribute("aria-pressed", state.filter.has(b.dataset.tier) ? "true" : "false");
  });
}

function renderFeed() {
  const el = $("#incidentList");
  const list = visibleIncidents();
  $("#feedCount").textContent = list.length === state.incidents.length
    ? state.incidents.length : `${list.length} / ${state.incidents.length}`;

  const sig = JSON.stringify([list.map((i) => [i.incident_id, i.tier, i.report_count, i.last_seen,
    sealBadge(sealInfo(i))]), [...state.newIds], Math.floor(Date.now() / 60000)]);
  if (sig === state.sig.feed) return syncSelection();
  state.sig.feed = sig;

  if (!state.incidents.length) {
    el.innerHTML = `<div class="empty">${icon("i-pin", "ico big")}
      <p>No active incidents. Load the Mumbai sample, or simulate a bystander report to watch the pipeline work.</p>
      <div class="head-actions"><button class="btn small" data-action="seed">${icon("i-seed")}Seed demo</button>
      <button class="btn small primary" data-action="new-report">${icon("i-plus")}New report</button></div></div>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty">${icon("i-search", "ico big")}<p>No incidents match the current search and filters.</p>
      <button class="btn small" data-action="clear-filters">Clear filters</button></div>`;
    return;
  }
  el.innerHTML = list.map((i, idx) => {
    const t = tierOf(i.tier);
    const reporters = reporterCount(i);
    const amb = i.ambient_detail;
    const isNew = state.newIds.has(i.incident_id) ? " is-new" : "";
    const badges = [sealBadge(sealInfo(i))].filter(Boolean).join("");
    return `<article class="card t-${t.key}${isNew}" data-id="${esc(i.incident_id)}" tabindex="0" role="button"
        aria-pressed="false" style="animation-delay:${Math.min(idx, 12) * 45}ms"
        aria-label="${esc(zoneLabel(i))}, ${esc(i.tier)}, ${plural(i.report_count, "report")}">
      <div class="card-top"><span class="zone">${esc(zoneLabel(i))}</span>${tierPill(i.tier)}</div>
      <div class="card-meta">
        <span title="Independent reporters / total reports">${icon("i-users")}${reporters} · ${plural(i.report_count, "report")}</span>
        <span class="${i.ambient_flagged ? "amb" : ""}">${icon("i-rain")}${amb ? esc(amb.risk_level) : "no ambient"}</span>
        <span>${icon("i-clock")}${ago(i.last_seen)}</span>
      </div>
      ${badges ? `<div class="card-badges">${badges}</div>` : ""}
    </article>`;
  }).join("");
  if (state.loaded) el.classList.add("settled");
  syncSelection();
}

function syncSelection() {
  $$("#incidentList .card").forEach((c) => {
    const on = c.dataset.id === state.selectedId;
    c.classList.toggle("is-selected", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderSkeletons() {
  $("#incidentList").innerHTML = '<div class="skeleton"></div>'.repeat(5);
  $("#ambientList").innerHTML = '<div class="skeleton" style="height:48px"></div>'.repeat(3);
}

/* --------------------------------------------------------------- ambient -- */
function renderAmbient() {
  const el = $("#ambientList");
  const perZone = {};
  state.incidents.forEach((i) => {
    const z = i.ambient_detail?.zone_id;
    if (z) perZone[z] = (perZone[z] || 0) + 1;
  });
  const sig = JSON.stringify([state.zones.map((z) => z.zone_id), perZone]);
  if (sig === state.sig.ambient) return;
  state.sig.ambient = sig;
  if (!state.zones.length) { el.innerHTML = '<p class="muted" style="padding:10px 4px">No ambient feed available.</p>'; return; }

  const zones = [...state.zones].sort((a, b) => (RISK_RANK[a.risk_level] ?? 3) - (RISK_RANK[b.risk_level] ?? 3));
  el.innerHTML = zones.map((z, idx) => {
    const rain = Math.min(1, z.rainfall_mm_last_3h / 120);
    let river = '<span class="meter-na">no river gauge</span>';
    if (z.river_level_m != null && z.river_danger_m) {
      const scale = z.river_danger_m * 1.4;
      const over = z.river_level_m > z.river_danger_m;
      river = `<div class="meter-label"><span>River</span><b>${z.river_level_m} m / ${z.river_danger_m} m</b></div>
        <div class="meter river${over ? " over" : ""}" title="Level ${z.river_level_m} m, danger mark ${z.river_danger_m} m">
          <i style="width:${Math.min(100, (z.river_level_m / scale) * 100)}%"></i>
          <span class="tick" style="left:${(z.river_danger_m / scale) * 100}%"></span></div>`;
    }
    const count = perZone[z.zone_id] || 0;
    return `<div class="zone-row" data-zone="${esc(z.zone_id)}" style="animation-delay:${idx * 60}ms" title="Show on map">
      <div>
        <div class="zone-name">${esc(z.zone_name)} <span class="risk ${esc(z.risk_level)}">${esc(z.risk_level)}</span>
          ${count ? `<span class="badge">${plural(count, "incident")}</span>` : ""}</div>
        <div class="zone-reason">${esc(z.reason)}</div>
      </div>
      <div><div class="meter-label"><span>Rain · 3h</span><b>${z.rainfall_mm_last_3h} mm</b></div>
        <div class="meter" title="${z.rainfall_mm_last_3h} mm in the last 3 hours"><i style="width:${rain * 100}%"></i></div></div>
      <div>${river}</div>
    </div>`;
  }).join("");
  if (state.loaded) el.classList.add("settled");
}

/* ---------------------------------------------------------------- detail -- */
async function select(id, { pan = true } = {}) {
  if (!id) return;
  const changed = state.selectedId !== id;
  state.selectedId = id;
  if (changed) state.detailTab = "overview";
  syncSelection();
  renderRing();
  const inc = state.incidents.find((i) => i.incident_id === id);
  if (pan && inc && map) map.flyTo([inc.lat, inc.lon], Math.max(map.getZoom(), 13), { duration: REDUCED ? 0 : 0.6 });
  const card = $(`#incidentList .card[data-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  if (changed || !state.detail || state.detail.id !== id) {
    $("#detail").innerHTML = '<div class="detail-scroll"><div class="skeleton" style="height:60px"></div><div class="skeleton"></div><div class="skeleton" style="height:140px"></div></div>';
    state.sig.detail = null;
  }
  await loadDetail(id);
}

async function loadDetail(id) {
  try {
    const data = await api(`/api/incidents/${encodeURIComponent(id)}`);
    if (state.selectedId !== id) return;
    state.detail = { id, data };
    renderDetail();
  } catch (e) {
    if (state.selectedId !== id) return;
    if (e.status === 404) { deselect(); toast("info", "Incident no longer active", "It merged into another cluster or the demo was reset."); }
    else $("#detail").innerHTML = `<div class="empty">${icon("i-alert", "ico big")}<p>Couldn't load this incident: ${esc(e.message)}</p></div>`;
  }
}

function deselect() {
  state.selectedId = null;
  state.detail = null;
  state.sig.detail = null;
  syncSelection();
  renderRing();
  $("#detail").innerHTML = `<div class="empty">${icon("i-pin", "ico big")}
    <p>Select an incident to inspect its reports, the rule-engine reasoning, ambient corroboration, and its evidence seal.</p></div>`;
}

function renderDetail() {
  if (!state.detail) return;
  const { data } = state.detail;
  // prefer the live feed copy so tier/seal reflect the latest refresh
  const inc = state.incidents.find((i) => i.incident_id === state.detail.id) || data.incident;
  const reports = [...(data.reports || [])].filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const seal = sealInfo(inc);
  const sig = JSON.stringify([inc.incident_id, inc.tier, inc.report_count, inc.last_seen, reports.length,
    seal && [seal.seq, seal.broken, seal.changed], state.detailTab, state.chainStatus?.valid]);
  if (sig === state.sig.detail) return;
  state.sig.detail = sig;

  const refs = new Set(reports.map((r) => r.reporter_ref || r.id));
  const wa = reports.filter((r) => r.channel === "whatsapp").length;
  const amb = inc.ambient_detail;
  const tab = state.detailTab;

  const overview = `
    <div class="section-label">Why this tier · deterministic rule engine</div>
    <ol class="reasons">${(inc.reasons || []).map((r, i) => `<li style="animation-delay:${i * 60}ms">${esc(r)}</li>`).join("")}</ol>
    <div class="section-label">Ambient corroboration · IMD / CWC</div>
    ${amb ? `<div class="ambient-box ${inc.ambient_flagged ? "flag" : ""}">
        <div class="ab-top"><b>${esc(amb.zone_name)}</b><span class="risk ${esc(amb.risk_level)}">${esc(amb.risk_level)}</span></div>
        <div class="ab-grid">
          <div><div class="meter-label"><span>Rain · 3h</span><b>${amb.rainfall_mm_last_3h} mm</b></div>
            <div class="meter"><i style="width:${Math.min(100, (amb.rainfall_mm_last_3h / 120) * 100)}%"></i></div></div>
          <div>${amb.river_level_m != null
            ? `<div class="meter-label"><span>River</span><b>${amb.river_level_m} / ${amb.river_danger_m} m</b></div>
               <div class="meter river${amb.river_level_m > amb.river_danger_m ? " over" : ""}"><i style="width:${Math.min(100, (amb.river_level_m / (amb.river_danger_m * 1.4)) * 100)}%"></i><span class="tick" style="left:${100 / 1.4}%"></span></div>`
            : '<span class="meter-na">no river gauge</span>'}</div>
        </div>
        <span class="muted">${esc(amb.reason)}</span>
      </div>`
      : '<p class="muted">No ambient IMD/CWC signal covers this location — the verdict rests on bystander reports alone.</p>'}`;

  const reportsHtml = reports.length ? `<ol class="timeline">${reports.map((r, i) => {
    let facts = {};
    try { facts = JSON.parse(r.extracted || "{}"); } catch (e) { /* ignore */ }
    const sev = facts.severity_indicators || [];
    const ch = r.channel === "sms" ? ["i-sms", "SMS"] : ["i-chat", "WhatsApp"];
    const media = { photo: ["i-camera", "photo"], voice: ["i-mic", "voice note"], text: ["i-text", "text"] }[r.media_kind] || ["i-info", r.media_kind || "none"];
    return `<li style="animation-delay:${Math.min(i, 8) * 50}ms"><div class="report">
      <div class="report-top"><span class="badge">${icon(ch[0])}${ch[1]}</span><span class="badge">${icon(media[0])}${esc(media[1])}</span>
        <span class="time" title="${esc(r.created_at)}">${clock(r.created_at)} · ${ago(r.created_at)}</span></div>
      <div><b>${esc(r.hazard_type || facts.hazard_type || "unknown hazard")}</b>${r.landmark ? ` · ${esc(r.landmark)}` : ""}</div>
      ${sev.length ? `<div class="sev">${sev.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : ""}
      <div class="who">${esc(r.reporter_ref || "anonymous")} · extraction ${Number(facts.confidence_of_extraction ?? 0).toFixed(2)} via ${esc(facts.source || "?")}</div>
    </div></li>`;
  }).join("")}</ol>` : '<p class="muted">No member reports.</p>';

  const payloadTier = seal?.payload?.tier;
  const sealHtml = !seal
    ? `<div class="seal-card"><div class="seal-title">${icon("i-lock")}Not yet sealed</div>
        <p class="muted">Sealing appends this verdict — tier, reasons, and member reports — to the SHA-256 hash chain. Any later edit to the record breaks verification.</p></div>`
    : `<div class="seal-card ${seal.broken ? "broken" : seal.changed ? "changed" : "ok"}">
        <div class="seal-title">${icon(seal.broken ? "i-shield-x" : "i-shield")}${seal.broken
          ? `Seal #${seal.seq} fails verification`
          : seal.changed ? `Verdict changed since seal #${seal.seq}` : `Sealed as ledger entry #${seal.seq}`}</div>
        <p class="muted">${seal.broken
          ? esc(state.chainStatus?.detail || "The chain no longer verifies from this entry.")
          : seal.changed ? `Sealed as ${esc(payloadTier)} with ${plural(seal.payload.report_count || 0, "report")}; re-seal to record the update.`
          : `Recorded ${ago(seal.entry.created_at)} · ${clock(seal.entry.created_at)}.`}</p>
        <div class="hashline"><span>hash</span><code>${esc(seal.entry.entry_hash)}</code><button class="icon-btn" data-copy="${esc(seal.entry.entry_hash)}" title="Copy hash">${icon("i-copy")}</button></div>
        <div class="hashline"><span>prev</span><code>${esc(seal.entry.previous_hash)}</code></div>
      </div>`;

  const sealBtn = seal && !seal.changed && !seal.broken
    ? `<button class="btn sealed" disabled>${icon("i-lock")}<span>Sealed · #${seal.seq}</span></button>`
    : `<button class="btn primary" data-action="seal">${icon("i-shield")}<span>${seal ? "Re-seal updated verdict" : "Seal to evidence ledger"}</span></button>`;

  $("#detail").innerHTML = `
    <div class="detail-scroll">
      <div class="detail-head">
        <h3>${esc(zoneLabel(inc))}</h3>
        <div class="row">${tierPill(inc.tier)}${amb ? `<span class="badge ${inc.ambient_flagged ? "warn" : ""}">${icon("i-rain")}ambient ${esc(amb.risk_level)}</span>` : ""}${sealBadge(seal)}</div>
      </div>
      <div class="facts">
        <div class="fact"><span>Reports</span><b>${inc.report_count}</b></div>
        <div class="fact"><span>Independent reporters</span><b>${refs.size || inc.report_count}</b></div>
        <div class="fact"><span>First seen</span><b>${clock(inc.first_seen)} · ${ago(inc.first_seen)}</b></div>
        <div class="fact"><span>Last seen</span><b>${clock(inc.last_seen)} · ${ago(inc.last_seen)}</b></div>
        <div class="fact"><span>Channels</span><b>WA ${wa} · SMS ${reports.length - wa}</b></div>
        <div class="fact"><span>Coordinates</span><b>${Number(inc.lat).toFixed(4)}, ${Number(inc.lon).toFixed(4)}</b></div>
      </div>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" data-tab="overview" aria-selected="${tab === "overview"}">Overview</button>
        <button class="tab" role="tab" data-tab="reports" aria-selected="${tab === "reports"}">Reports (${reports.length})</button>
        <button class="tab" role="tab" data-tab="seal" aria-selected="${tab === "seal"}">Evidence seal</button>
      </div>
      <div class="tabpanel" role="tabpanel">${tab === "reports" ? reportsHtml : tab === "seal" ? sealHtml : overview}</div>
    </div>
    <div class="action-bar">
      ${sealBtn}
      <button class="btn ghost" data-action="locate" title="Locate on map">${icon("i-pin")}</button>
      <button class="btn ghost" data-action="copy-id" title="Copy incident ID">${icon("i-copy")}</button>
    </div>`;
}

async function sealSelected(btn) {
  const id = state.selectedId;
  if (!id) return;
  setBtnLoading(btn, true);
  try {
    const res = await postJSON(`/api/incidents/${encodeURIComponent(id)}/verify`);
    const e = res.ledger_entry;
    state.freshSeqs.add(e.seq);
    toast("success", `Sealed as ledger entry #${e.seq}`, `hash ${e.entry_hash.slice(0, 16)}…`);
    await loadAll();
  } catch (err) {
    toast("error", "Couldn't seal incident", err.message);
    setBtnLoading(btn, false);
  }
}

/* ---------------------------------------------------------------- ledger -- */
function renderLedger() {
  const st = state.chainStatus;
  const status = $("#ledgerStatus");
  const stateName = !st || !state.chain.length ? "idle" : st.valid ? "ok" : "bad";
  status.dataset.state = stateName;
  status.innerHTML = stateName === "idle"
    ? `${icon("i-shield")}<span>Ledger empty — seal an incident to start the chain</span>`
    : st.valid
      ? `${icon("i-shield")}<span>Chain intact · ${plural(st.length, "entry", "entries")} verified</span>`
      : `${icon("i-shield-x")}<span title="${esc(st.detail)}">Tamper detected at entry #${st.broken_at} · chain fails verification</span>`;

  const el = $("#ledgerList");
  const sig = JSON.stringify([state.chain.map((e) => [e.seq, e.entry_hash, e.payload]), st?.valid, st?.broken_at]);
  if (sig === state.sig.ledger) return;
  state.sig.ledger = sig;
  if (!state.chain.length) {
    el.innerHTML = `<div class="empty">${icon("i-lock", "ico big")}<p>No sealed verdicts yet. Open an incident and seal it — each entry folds in the previous hash.</p></div>`;
    return;
  }
  const incIds = new Set(state.incidents.map((i) => i.incident_id));
  el.innerHTML = [...state.chain].reverse().map((e, idx) => {
    const p = parsePayload(e);
    const broken = st && !st.valid && st.broken_at != null && e.seq >= st.broken_at;
    const fresh = state.freshSeqs.has(e.seq) ? " fresh" : "";
    return `<div class="block${broken ? " broken" : ""}${fresh}" data-inc="${esc(e.incident_id)}" style="animation-delay:${Math.min(idx, 10) * 40}ms"
        title="${incIds.has(e.incident_id) ? "Open incident" : "Incident no longer active"}">
      <div class="block-top"><span class="seq">#${e.seq}</span><span class="zone-l">${esc(p.zone_name || e.incident_id.slice(0, 8))}</span>
        ${tierPill(p.tier)}<span class="when">${ago(e.created_at)}</span></div>
      <div class="hashline"><span class="k">prev</span><code>${esc(e.previous_hash)}</code></div>
      <div class="hashline"><span class="k">hash</span><code>${esc(e.entry_hash)}</code>
        <button class="icon-btn" data-copy="${esc(e.entry_hash)}" title="Copy hash">${icon("i-copy")}</button></div>
      ${broken && e.seq === st.broken_at ? `<div class="hashline" style="color:var(--rose)">${icon("i-alert")}${esc(st.detail)}</div>` : ""}
    </div>`;
  }).join("") + '<div class="genesis">genesis · 0000…0000</div>';
  if (state.loaded) el.classList.add("settled");
  state.freshSeqs.clear();
}

/* ---------------------------------------------------------------- loading -- */
function announceChanges(incidents) {
  if (!state.loaded) { incidents.forEach((i) => state.known.set(i.incident_id, i.tier)); return; }
  const fresh = [], escalated = [];
  incidents.forEach((i) => {
    const prev = state.known.get(i.incident_id);
    if (prev === undefined) fresh.push(i);
    else if (prev !== i.tier && tierOf(i.tier).rank < tierOf(prev).rank) escalated.push([i, prev]);
    state.known.set(i.incident_id, i.tier);
  });
  const live = new Set(incidents.map((i) => i.incident_id));
  [...state.known.keys()].forEach((id) => { if (!live.has(id)) state.known.delete(id); });
  fresh.forEach((i) => state.newIds.add(i.incident_id));
  if (fresh.length) setTimeout(() => { fresh.forEach((i) => state.newIds.delete(i.incident_id)); }, 4000);
  return { fresh, escalated };
}

async function loadAll({ announce = false, quiet = false } = {}) {
  if (state.loading) return false;
  state.loading = true;
  const btn = $("#refreshBtn");
  if (!quiet) setBtnLoading(btn, true);
  try {
    const [incidents, reports, ledger, verify, ambient] = await Promise.all([
      api("/api/incidents"), api("/api/reports"), api("/api/ledger"), api("/api/ledger/verify"),
      state.zones.length ? null : api("/api/ambient"),
    ]);
    if (ambient) state.zones = ambient.zones || [];
    state.reports = reports || [];
    state.reportById = new Map(state.reports.map((r) => [r.id, r]));
    const changes = announceChanges(incidents || []);
    state.incidents = incidents || [];
    state.chain = ledger?.chain || [];
    state.chainStatus = verify;
    state.lastUpdated = Date.now();
    const firstLoad = !state.loaded;
    state.loaded = true;

    renderAll();
    if (!state.fitted && state.incidents.length) { fitToIncidents(!firstLoad); state.fitted = true; }
    if (state.selectedId) {
      if (!state.incidents.some((i) => i.incident_id === state.selectedId)) deselect();
      else {
        const live = state.incidents.find((i) => i.incident_id === state.selectedId);
        const cached = state.detail?.data?.incident;
        if (!cached || cached.report_count !== live.report_count || cached.last_seen !== live.last_seen) await loadDetail(state.selectedId);
        else renderDetail();
      }
    }
    if (announce && changes) {
      if (changes.fresh.length > 2) toast("info", `${changes.fresh.length} new incidents`, "The feed has been updated.");
      else changes.fresh.forEach((i) => toast("info", `New incident · ${zoneLabel(i)}`, `${i.tier} · ${plural(i.report_count, "report")}`));
      changes.escalated.forEach(([i, prev]) => toast("warn", `Escalated · ${zoneLabel(i)}`, `${prev} → ${i.tier}`));
    }
    return true;
  } catch (e) {
    if (!quiet) toast("error", "Couldn't refresh the feed", e.message || "Network error");
    return false;
  } finally {
    state.loading = false;
    setBtnLoading(btn, false);
  }
}

function renderAll() {
  renderKpis();
  renderFilterChips();
  renderFeed();
  renderZones();
  renderMarkers();
  renderAmbient();
  renderLedger();
  tickUpdated();
}

function tickUpdated() {
  const span = $("#updatedAt span");
  span.textContent = state.lastUpdated ? `Synced ${ago(new Date(state.lastUpdated).toISOString())}` : "—";
}

function scheduleAuto() {
  clearInterval(state.timer);
  if (!state.auto) return;
  state.timer = setInterval(() => {
    if (document.hidden || $("#reportDialog").open) return;
    loadAll({ announce: true, quiet: true });
  }, REFRESH_MS);
}

/* -------------------------------------------------------------- actions -- */
async function seed(btn) {
  setBtnLoading(btn, true);
  try {
    const res = await postJSON("/api/demo/seed");
    state.fitted = false;
    await loadAll();
    toast("success", `Loaded ${plural(res.seeded, "sample report")}`, "Mumbai monsoon scenario · routed through the real adapters.");
  } catch (e) {
    toast("error", "Seeding failed", e.message);
  } finally { setBtnLoading(btn, false); }
}

let resetTimer = null;
async function reset(btn) {
  const label = $("span", btn);
  if (!btn.classList.contains("confirming")) {
    btn.classList.add("confirming");
    label.textContent = "Confirm reset";
    resetTimer = setTimeout(() => { btn.classList.remove("confirming"); label.textContent = "Reset"; }, 3500);
    return;
  }
  clearTimeout(resetTimer);
  btn.classList.remove("confirming");
  label.textContent = "Reset";
  setBtnLoading(btn, true);
  try {
    await postJSON("/api/demo/reset");
    deselect();
    state.known.clear();
    state.loaded = false;           // don't announce everything as "new" after the wipe
    state.fitted = false;
    state.sig = {};
    await loadAll();
    toast("success", "Demo reset", "All reports and ledger entries were cleared.");
  } catch (e) {
    toast("error", "Reset failed", e.status === 404 ? "This API build doesn't support reset yet." : e.message);
  } finally { setBtnLoading(btn, false); }
}

async function verifyLedger(btn) {
  setBtnLoading(btn, true);
  try {
    await loadAll();
    const st = state.chainStatus;
    const s = $("#ledgerStatus");
    s.classList.remove("flash"); void s.offsetWidth; s.classList.add("flash");
    if (!state.chain.length) toast("info", "Ledger is empty", "Seal an incident first.");
    else if (st.valid) toast("success", "Chain verified", `All ${plural(st.length, "entry", "entries")} recompute to their stored hashes.`);
    else toast("error", `Tamper detected at entry #${st.broken_at}`, st.detail);
  } finally { setBtnLoading(btn, false); }
}

async function tamper(btn) {
  setBtnLoading(btn, true);
  try {
    const res = await postJSON("/api/demo/tamper");
    await loadAll();
    const s = $("#ledgerStatus");
    s.classList.remove("flash"); void s.offsetWidth; s.classList.add("flash");
    toast("warn", `Entry #${res.tampered_seq} edited in the database`,
      state.chainStatus && !state.chainStatus.valid
        ? `Verification now fails at entry #${state.chainStatus.broken_at} — the edit is caught.`
        : "Run Verify chain to check integrity.");
  } catch (e) {
    toast(e.status === 400 ? "info" : "error", e.status === 400 ? "Nothing to tamper with yet" : "Tamper simulation failed",
      e.status === 400 ? "Seal an incident first, then try again." : e.message);
  } finally { setBtnLoading(btn, false); }
}

function exportCsv() {
  const cols = ["incident_id", "zone", "tier", "report_count", "independent_reporters", "ambient_flagged",
    "ambient_risk", "lat", "lon", "first_seen", "last_seen", "sealed_seq", "seal_state"];
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = visibleIncidents().map((i) => {
    const s = sealInfo(i);
    return [i.incident_id, zoneLabel(i), i.tier, i.report_count, reporterCount(i), i.ambient_flagged,
      i.ambient_detail?.risk_level || "", i.lat, i.lon, i.first_seen, i.last_seen, s?.seq ?? "",
      s ? (s.broken ? "broken" : s.changed ? "changed" : "sealed") : "unsealed"].map(cell).join(",");
  });
  if (!rows.length) return toast("info", "Nothing to export", "The feed is empty for the current filters.");
  download(`prahari-incidents-${stamp()}.csv`, [cols.join(","), ...rows].join("\n"), "text/csv");
  toast("success", "Incidents exported", `${plural(rows.length, "row")} · CSV`);
}

function exportLedger() {
  if (!state.chain.length) return toast("info", "Ledger is empty", "Seal an incident first.");
  const doc = { exported_at: new Date().toISOString(), source: API || location.origin,
    verification: state.chainStatus, chain: state.chain };
  download(`prahari-ledger-${stamp()}.json`, JSON.stringify(doc, null, 2), "application/json");
  toast("success", "Ledger exported", `${plural(state.chain.length, "entry", "entries")} with verification result`);
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.classList.add("done"); setTimeout(() => btn.classList.remove("done"), 1200); }
    toast("success", "Copied to clipboard", `${text.slice(0, 24)}${text.length > 24 ? "…" : ""}`, 2200);
  } catch (e) {
    toast("error", "Copy failed", "Clipboard access was blocked by the browser.");
  }
}

function stepSelection(dir) {
  const list = visibleIncidents();
  if (!list.length) return;
  const idx = list.findIndex((i) => i.incident_id === state.selectedId);
  const next = idx === -1 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, idx + dir));
  select(list[next].incident_id);
}

/* ------------------------------------------------------- report dialog -- */
const dialog = () => $("#reportDialog");

async function openReportDialog() {
  const dlg = dialog();
  if (dlg.open) return;
  if (!state.zones.length) {
    try { state.zones = (await api("/api/ambient")).zones || []; } catch (e) {
      return toast("error", "API unavailable", "Can't load locations for the report simulator.");
    }
  }
  const sel = $("#zoneSelect");
  const selected = state.incidents.find((i) => i.incident_id === state.selectedId)?.ambient_detail?.zone_id;
  sel.innerHTML = state.zones.map((z) =>
    `<option value="${esc(z.zone_id)}"${z.zone_id === selected ? " selected" : ""}>${esc(z.zone_name)} — ${esc(z.risk_level)}</option>`).join("");
  const repeat = $('input[name="reporter"][value="repeat"]');
  repeat.disabled = !state.lastReporter;
  if (!state.lastReporter) $('input[name="reporter"][value="new"]').checked = true;
  syncDialog();
  dlg.showModal();
}

function syncDialog() {
  const sms = $('input[name="channel"]:checked').value === "sms";
  $("#mediaField").classList.toggle("is-hidden", sms);
  $("#noteField").classList.toggle("is-hidden", sms);
  const z = state.zones.find((x) => x.zone_id === $("#zoneSelect").value);
  $("#zoneHint").innerHTML = sms
    ? `Sends <code>FLOOD ${esc(z?.landmarks?.[0] || "&lt;landmark&gt;")}</code> — resolved to coordinates via the landmark gazetteer.`
    : "Shares the phone's GPS location, as a WhatsApp location pin would.";
}

async function submitReport(ev) {
  ev.preventDefault();
  const btn = $("#submitReportBtn");
  const channel = $('input[name="channel"]:checked').value;
  const media = $('input[name="media"]:checked').value;
  const z = state.zones.find((x) => x.zone_id === $("#zoneSelect").value);
  if (!z) return toast("error", "Pick a location", "Choose where the bystander is.");
  const repeat = $('input[name="reporter"]:checked').value === "repeat" && state.lastReporter;
  const ref = repeat ? state.lastReporter
    : `${channel === "sms" ? "sms" : "wa"}:+91-DEMO-${String(Math.floor(1000 + Math.random() * 9000))}`;
  const note = $("#noteInput").value.trim();
  const jitter = () => (Math.random() - 0.5) * 0.0012;
  const landmark = z.landmarks?.[0] || z.zone_name;

  const payload = channel === "sms"
    ? { channel: "sms", From: ref, Body: `FLOOD ${landmark}` }
    : {
      channel: "whatsapp", From: ref,
      Latitude: +(z.lat + jitter()).toFixed(6), Longitude: +(z.lon + jitter()).toFixed(6),
      Body: note || (media === "text" ? `flooding near ${landmark}` : ""),
      NumMedia: media === "text" ? 0 : 1,
      ...(media === "text" ? {} : {
        MediaUrl0: media === "photo" ? "demo://bystander-photo.jpg" : "demo://bystander-voice.ogg",
        MediaContentType0: media === "photo" ? "image/jpeg" : "audio/ogg",
      }),
    };

  const before = new Map(state.known);
  setBtnLoading(btn, true);
  try {
    const report = await postJSON("/api/report", payload);
    state.lastReporter = ref;
    dialog().close();
    $("#noteInput").value = "";
    await loadAll();
    const inc = state.incidents.find((i) => (i.report_ids || []).includes(report.id));
    if (inc) {
      state.filter.add(inc.tier);
      renderFilterChips(); renderFeed(); renderMarkers();
      select(inc.incident_id);
      const prev = before.get(inc.incident_id);
      const detail = prev && prev !== inc.tier ? `${prev} → ${inc.tier}` : `${inc.tier} · ${plural(inc.report_count, "report")}`;
      toast(prev && prev !== inc.tier ? "warn" : "success",
        `Report ingested via ${channel === "sms" ? "SMS" : "WhatsApp"} · ${zoneLabel(inc)}`,
        repeat ? `${detail} — repeat sender, so it doesn't count as new corroboration.` : detail);
    } else {
      toast("success", "Report ingested", "It will appear once it clusters with a location.");
    }
  } catch (e) {
    toast("error", "Report rejected", e.message);
  } finally { setBtnLoading(btn, false); }
}

/* --------------------------------------------------------------- wiring -- */
function bind() {
  $("#refreshBtn").addEventListener("click", () => loadAll({ announce: true }));
  $("#seedBtn").addEventListener("click", (e) => seed(e.currentTarget));
  $("#resetBtn").addEventListener("click", (e) => reset(e.currentTarget));
  $("#newReportBtn").addEventListener("click", openReportDialog);
  $("#verifyLedgerBtn").addEventListener("click", (e) => verifyLedger(e.currentTarget));
  $("#tamperBtn").addEventListener("click", (e) => tamper(e.currentTarget));
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#exportLedgerBtn").addEventListener("click", exportLedger);
  $("#fitBtn").addEventListener("click", () => fitToIncidents());

  const zt = $("#ambientToggle");
  zt.setAttribute("aria-pressed", String(state.showZones));
  zt.addEventListener("click", () => {
    state.showZones = !state.showZones;
    store.set("prahari.zones", state.showZones);
    zt.setAttribute("aria-pressed", String(state.showZones));
    if (state.showZones) zoneLayer.addTo(map); else zoneLayer.remove();
  });

  const auto = $("#autoToggle");
  auto.checked = state.auto;
  auto.addEventListener("change", () => {
    state.auto = auto.checked;
    store.set("prahari.live", state.auto);
    scheduleAuto();
    toast("info", state.auto ? "Live updates on" : "Live updates paused", state.auto ? "Refreshing every 15 seconds." : "Use Refresh (R) to sync manually.", 2500);
  });

  let qTimer;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; renderFeed(); renderMarkers(); }, 120);
  });
  const sort = $("#sortSelect");
  sort.value = state.sort;
  sort.addEventListener("change", () => { state.sort = sort.value; store.set("prahari.sort", state.sort); renderFeed(); });

  $$(".fchip").forEach((chip) => chip.addEventListener("click", (e) => {
    const t = chip.dataset.tier;
    if (e.shiftKey) state.filter = new Set([t]);          // shift-click: solo this tier
    else if (state.filter.has(t)) state.filter.delete(t);
    else state.filter.add(t);
    renderFilterChips(); renderFeed(); renderMarkers();
  }));

  const list = $("#incidentList");
  list.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) select(card.dataset.id);
  });
  list.addEventListener("keydown", (e) => {
    const card = e.target.closest(".card");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(card.dataset.id); }
  });

  $("#ambientList").addEventListener("click", (e) => {
    const row = e.target.closest(".zone-row");
    const z = row && state.zones.find((x) => x.zone_id === row.dataset.zone);
    if (z) map.flyTo([z.lat, z.lon], 14, { duration: REDUCED ? 0 : 0.6 });
  });

  $("#ledgerList").addEventListener("click", (e) => {
    if (e.target.closest("[data-copy]")) return;
    const block = e.target.closest(".block");
    if (block && state.incidents.some((i) => i.incident_id === block.dataset.inc)) {
      state.detailTab = "seal";
      if (state.selectedId === block.dataset.inc) { state.sig.detail = null; renderDetail(); }
      else select(block.dataset.inc).then(() => { state.detailTab = "seal"; state.sig.detail = null; renderDetail(); });
    }
  });

  // delegated actions (detail, empty states, copy buttons)
  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) return copy(copyBtn.dataset.copy, copyBtn);
    const tabBtn = e.target.closest(".tab[data-tab]");
    if (tabBtn) { state.detailTab = tabBtn.dataset.tab; renderDetail(); return; }
    const act = e.target.closest("[data-action]");
    if (!act) return;
    const a = act.dataset.action;
    if (a === "seed") seed(act);
    else if (a === "new-report") openReportDialog();
    else if (a === "clear-filters") {
      state.filter = new Set(Object.keys(TIERS)); state.query = ""; $("#searchInput").value = "";
      renderFilterChips(); renderFeed(); renderMarkers();
    } else if (a === "seal") sealSelected(act);
    else if (a === "locate") {
      const inc = state.incidents.find((i) => i.incident_id === state.selectedId);
      if (inc) map.flyTo([inc.lat, inc.lon], 15, { duration: REDUCED ? 0 : 0.6 });
    } else if (a === "copy-id" && state.selectedId) copy(state.selectedId, act);
  });

  // dialog
  const dlg = dialog();
  $("#reportForm").addEventListener("submit", submitReport);
  $("#closeDialogBtn").addEventListener("click", () => dlg.close());
  $("#cancelDialogBtn").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // backdrop
  $$('input[name="channel"]').forEach((r) => r.addEventListener("change", syncDialog));
  $("#zoneSelect").addEventListener("change", syncDialog);
  $("#quickChips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]");
    if (!b) return;
    const input = $("#noteInput");
    input.value = input.value ? `${input.value}, ${b.dataset.q}` : b.dataset.q;
    input.focus();
  });

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches("input, select, textarea")) {
      if (e.key === "Escape" && e.target.id === "searchInput") e.target.blur();
      return;
    }
    if (dlg.open) return;
    switch (e.key) {
      case "/": e.preventDefault(); $("#searchInput").focus(); break;
      case "r": case "R": loadAll({ announce: true }); break;
      case "n": case "N": e.preventDefault(); openReportDialog(); break;
      case "j": case "J": stepSelection(1); break;
      case "k": case "K": stepSelection(-1); break;
      case "Escape": if (state.selectedId) deselect(); break;
      default: break;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.auto && state.loaded && Date.now() - (state.lastUpdated || 0) > REFRESH_MS) {
      loadAll({ announce: true, quiet: true });
    }
  });
  window.addEventListener("resize", () => { state.sig.activity = null; renderActivity(); });
  bindChartTip();
  setInterval(tickUpdated, 5000);
}

async function boot() {
  renderSkeletons();
  initMap();
  bind();
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (await loadAll({ quiet: true })) { scheduleAuto(); return; }
    $("#wakeBanner").hidden = false;
    $("#wakeText").textContent = `Still waking the evidence API — retrying (${attempt}/10). Free-tier servers can take up to a minute.`;
    setPill("waking", "Waking API…");
    await sleep(6000);
  }
  $("#wakeBanner").hidden = true;
  $("#incidentList").innerHTML = `<div class="empty">${icon("i-alert", "ico big")}<p>The evidence API isn't responding. Check your connection, then press Refresh.</p></div>`;
  scheduleAuto();
}

boot();
