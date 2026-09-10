// Prahari officer console — talks to the FastAPI backend.
const API = "";
const TIER_CLASS = { "High-Confidence": "high", "Corroborated": "corr", "Unverified": "unv" };
const TIER_COLOR = { "High-Confidence": "#ef4444", "Corroborated": "#f59e0b", "Unverified": "#64748b" };

let map, markerLayer, incidents = [];

function initMap() {
  map = L.map("map").setView([19.05, 72.86], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function tierClass(t) { return TIER_CLASS[t] || "unv"; }

async function loadIncidents() {
  incidents = await api("/api/incidents");
  renderList();
  renderMarkers();
}

function renderList() {
  const el = document.getElementById("incidentList");
  if (!incidents.length) {
    el.innerHTML = '<p class="muted" style="padding:10px">No reports yet. Click "Seed demo reports".</p>';
    return;
  }
  el.innerHTML = incidents.map((i) => {
    const cls = tierClass(i.tier);
    const where = i.zone_name || `${i.lat.toFixed(4)}, ${i.lon.toFixed(4)}`;
    return `<div class="incident-card ${cls}" data-id="${i.incident_id}">
      <div class="row">
        <span class="zone">${where}</span>
        <span class="tier ${cls}">${i.tier}</span>
      </div>
      <div class="meta">${i.report_count} report(s) · ${i.ambient_flagged ? "ambient risk flagged" : "no ambient flag"}</div>
    </div>`;
  }).join("");
  el.querySelectorAll(".incident-card").forEach((c) =>
    c.addEventListener("click", () => showDetail(c.dataset.id)));
}

function renderMarkers() {
  markerLayer.clearLayers();
  incidents.forEach((i) => {
    if (!i.lat && !i.lon) return;
    const m = L.circleMarker([i.lat, i.lon], {
      radius: 8 + i.report_count * 2,
      color: TIER_COLOR[i.tier],
      fillColor: TIER_COLOR[i.tier],
      fillOpacity: 0.55,
      weight: 2,
    }).addTo(markerLayer);
    m.bindTooltip(`${i.zone_name || "Incident"} — ${i.tier}`);
    m.on("click", () => showDetail(i.incident_id));
  });
}

async function showDetail(id) {
  const data = await api(`/api/incidents/${id}`);
  const inc = data.incident;
  const cls = tierClass(inc.tier);
  const reports = data.reports || [];

  const ambient = inc.ambient_detail
    ? `<div class="ambient-box ${inc.ambient_flagged ? "flag" : ""}">
        <b>${inc.ambient_detail.zone_name}</b> — ${inc.ambient_detail.risk_level.toUpperCase()}<br/>
        Rainfall (3h): ${inc.ambient_detail.rainfall_mm_last_3h} mm
        ${inc.ambient_detail.river_level_m != null ? `· River: ${inc.ambient_detail.river_level_m}m (danger ${inc.ambient_detail.river_danger_m}m)` : ""}<br/>
        <span class="muted">${inc.ambient_detail.reason}</span>
      </div>`
    : '<p class="muted">No ambient IMD/CWC signal for this location.</p>';

  const reportHtml = reports.map((r) => {
    let facts = {};
    try { facts = JSON.parse(r.extracted || "{}"); } catch (e) {}
    const sev = (facts.severity_indicators || []).join(", ") || "—";
    return `<div class="report">
      <span class="badge">${r.channel}</span>
      <span class="badge">${r.media_kind}</span>
      <b>${r.hazard_type || "unknown"}</b><br/>
      Severity: ${sev}<br/>
      ${r.landmark ? `Landmark: ${r.landmark}<br/>` : ""}
      <span class="muted">extraction conf: ${(facts.confidence_of_extraction ?? 0)} · via ${facts.source || "?"} · ${r.created_at?.slice(11,19) || ""}</span>
    </div>`;
  }).join("");

  document.getElementById("detail").innerHTML = `
    <h3>${inc.zone_name || "Unmapped incident"}</h3>
    <span class="tier ${cls}">${inc.tier}</span> · ${inc.report_count} report(s)

    <div class="section-label">Why this tier (rule engine)</div>
    <ul class="reasons">${inc.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>

    <div class="section-label">Ambient corroboration</div>
    ${ambient}

    <div class="section-label">Member reports</div>
    ${reportHtml || '<p class="muted">No reports.</p>'}

    <button class="btn primary verify-btn" id="verifyBtn">Commit to evidence ledger</button>
  `;
  document.getElementById("verifyBtn").addEventListener("click", () => verifyIncident(id));
}

async function verifyIncident(id) {
  await api(`/api/incidents/${id}/verify`, { method: "POST" });
  await loadLedger();
}

async function loadLedger() {
  const [{ chain }, status] = await Promise.all([
    api("/api/ledger"),
    api("/api/ledger/verify"),
  ]);
  const s = document.getElementById("ledgerStatus");
  s.className = "ledger-status " + (status.valid ? "ok" : "bad");
  s.textContent = status.valid
    ? `✓ Chain intact — ${status.length} verified entr${status.length === 1 ? "y" : "ies"}`
    : `✗ TAMPER DETECTED at entry #${status.broken_at}: ${status.detail}`;

  const el = document.getElementById("ledgerList");
  el.innerHTML = chain.map((e) => {
    const broken = !status.valid && e.seq >= status.broken_at;
    let tier = "";
    try { tier = JSON.parse(e.payload).tier; } catch (x) {}
    return `<div class="ledger-entry ${broken ? "broken" : ""}">
      <span class="k">#${e.seq}</span> · ${e.incident_id.slice(0, 8)} · <b>${tier}</b><br/>
      <span class="k">prev</span> <span class="hash">${e.previous_hash.slice(0, 24)}…</span><br/>
      <span class="k">hash</span> <span class="hash">${e.entry_hash.slice(0, 24)}…</span>
    </div>`;
  }).join("") || '<p class="muted" style="padding:10px">Ledger empty. Verify an incident to append.</p>';
}

document.getElementById("seedBtn").addEventListener("click", async () => {
  await api("/api/demo/seed", { method: "POST" });
  await loadIncidents();
});
document.getElementById("refreshBtn").addEventListener("click", loadIncidents);
document.getElementById("verifyLedgerBtn").addEventListener("click", loadLedger);
document.getElementById("tamperBtn").addEventListener("click", async () => {
  await api("/api/demo/tamper", { method: "POST" });
  await loadLedger();
});

initMap();
loadIncidents();
loadLedger();
