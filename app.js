// =======================
// TLC Hotspot Map - app.js
// Clear signals + detailed green shading
// - Neutral zones: gray
// - Bottom zones: red
// - Top zones: GREEN but shaded (light->dark) by rating (more detailed)
// =======================

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

function getApiBase(){
  const u = new URL(location.href);
  const qp = u.searchParams.get("api");
  if (qp) return qp.replace(/\/+$/,"");
  return "https://web-production-78f67.up.railway.app";
}
const RAILWAY_BASE = getApiBase();

// ===== Color helpers =====
// Make greens more detailed: light green -> dark green
function greenShade(rating){ // rating 1..100
  const t = Math.max(0, Math.min(1, (Number(rating) - 1) / 99));
  // interpolate between light and dark green
  const r = Math.round(200 + (0   - 200) * t);
  const g = Math.round(255 + (176 - 255) * t);
  const b = Math.round(200 + (80  - 200) * t);
  const toHex = (n)=>n.toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Normalize center ordering
function normalizeLatLng(c){
  if (!c || !Array.isArray(c) || c.length !== 2) return null;
  const a = Number(c[0]);
  const b = Number(c[1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) return [b, a]; // swap if [lng,lat]
  return [a, b];
}

// Map
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// panes
map.createPane("polys"); map.getPane("polys").style.zIndex = 400;
map.createPane("icons"); map.getPane("icons").style.zIndex = 650;

// layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: () => ({
    color: "#2f2f2f",
    weight: 1,
    fillColor: "#bdbdbd",
    fillOpacity: 0.28
  }),
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const iconLayer = L.layerGroup().addTo(map);

// UI
const timeLabelEl = document.getElementById("timeLabel");
const sliderEl = document.getElementById("slider");
const statusEl = document.getElementById("statusLine");
const showIconsEl = document.getElementById("showIcons");
const topNEl = document.getElementById("topN");
const botNEl = document.getElementById("botN");
const generateBtn = document.getElementById("generateBtn");

// minimize
const panelEl = document.getElementById("panel");
const miniBtn = document.getElementById("miniBtn");
if (miniBtn && panelEl){
  miniBtn.addEventListener("click", () => {
    panelEl.classList.toggle("collapsed");
    miniBtn.textContent = panelEl.classList.contains("collapsed") ? "Open" : "Min";
  });
}

function makeBadgeIcon(type){
  const isTop = type === "TOP";
  const symbol = isTop ? "✓" : "✖";
  const stroke = isTop ? "#00b050" : "#e60000";
  const html = `
    <div style="
      width:24px;height:24px;border-radius:12px;
      background:#fff;
      border:3px solid ${stroke};
      display:flex;align-items:center;justify-content:center;
      font-weight:900;
      font-size:15px;
      color:#111;
      box-shadow:0 1px 6px rgba(0,0,0,0.25);
    ">${symbol}</div>
  `;
  return L.divIcon({ html, className:"", iconSize:[24,24], iconAnchor:[12,12] });
}
const topIcon = makeBadgeIcon("TOP");
const botIcon = makeBadgeIcon("BOTTOM");

let timeline = [];
let framesByTime = new Map();

function clearAll(){
  polyLayer.clearLayers();
  iconLayer.clearLayers();
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  timeLabelEl.textContent = formatTimeLabel(key);
  clearAll();

  const feats = (frame.polygons && frame.polygons.features) ? frame.polygons.features : [];
  if (!feats.length) return;

  const items = [];
  for (const f of feats){
    const p = f.properties || {};
    const rating = (p.rating !== undefined) ? Number(p.rating) : null;
    if (rating === null || Number.isNaN(rating)) continue;
    items.push({ feature: f, props: p, rating, center: normalizeLatLng(p.center) });
  }

  const topN = Math.max(0, Number(topNEl?.value || 25));
  const botN = Math.max(0, Number(botNEl?.value || 25));

  const hi = [...items].sort((a,b)=>b.rating - a.rating).slice(0, topN);
  const lo = [...items].sort((a,b)=>a.rating - b.rating).slice(0, botN);

  const idOf = (p, c) => (p.LocationID || p.location_id || p.zone_id || p.zone || JSON.stringify(c));
  const topSet = new Set(hi.map(x => idOf(x.props, x.center)));
  const botSet = new Set(lo.map(x => idOf(x.props, x.center)));

  const styled = {
    type: "FeatureCollection",
    features: feats.map(f => {
      const p = f.properties || {};
      const rating = (p.rating !== undefined) ? Number(p.rating) : null;
      const c = normalizeLatLng(p.center);
      const keyId = idOf(p, c);

      // defaults
      let fillColor = "#bdbdbd"; // neutral gray
      let fillOpacity = 0.26;
      let borderColor = "#2f2f2f";
      let weight = 1;

      if (topSet.has(keyId)){
        // detailed green shading based on rating
        fillColor = greenShade(rating);
        fillOpacity = 0.42;
        borderColor = "#008a40";
        weight = 2;
      } else if (botSet.has(keyId)){
        fillColor = "#e60000";
        fillOpacity = 0.34;
        borderColor = "#b00000";
        weight = 2;
      }

      return {
        ...f,
        properties: {
          ...p,
          style: { color: borderColor, weight, fillColor, fillOpacity }
        }
      };
    })
  };

  polyLayer.addData(styled);

  const showIcons = !!(showIconsEl && showIconsEl.checked);
  if (!showIcons) return;
  if (map.getZoom() < 12) return;

  function popupHtml(it, label){
    const p = it.props || {};
    const zone = p.zone || p.Zone || p.name || "Zone";
    const borough = p.borough || p.Borough || "Unknown";
    const pickups = (p.pickups !== undefined) ? p.pickups : "n/a";
    const avgPay = p.avg_driver_pay;
    const avgTips = p.avg_tips;
    return `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        <div style="color:#666; margin-bottom:4px;">${borough} — <b>${label}</b></div>
        <div><b>Rating:</b> <span style="font-weight:900;">${it.rating}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(avgPay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(avgTips)}</div>
      </div>
    `;
  }

  for (const it of hi){
    if (!it.center) continue;
    const m = L.marker([it.center[0], it.center[1]], { icon: topIcon, pane: "icons" });
    m.bindPopup(popupHtml(it, "Top (Good)"), { maxWidth: 360 });
    m.addTo(iconLayer);
  }
  for (const it of lo){
    if (!it.center) continue;
    const m = L.marker([it.center[0], it.center[1]], { icon: botIcon, pane: "icons" });
    m.bindPopup(popupHtml(it, "Bottom (Bad)"), { maxWidth: 360 });
    m.addTo(iconLayer);
  }
}

async function loadHotspots(){
  statusEl.textContent = "Loading from Railway…";
  const url = `${RAILWAY_BASE}/hotspots`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    let txt = "";
    try { txt = await res.text(); } catch(e){}
    throw new Error(`Failed to fetch hotspots (${res.status}). ${txt}`);
  }

  const payload = await res.json();
  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  sliderEl.min = 0;
  sliderEl.max = Math.max(0, timeline.length - 1);
  sliderEl.step = 1;
  sliderEl.value = 0;

  let pending = null;
  sliderEl.addEventListener("input", () => {
    pending = Number(sliderEl.value);
    if (sliderEl._raf) return;
    sliderEl._raf = requestAnimationFrame(() => {
      sliderEl._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  function refresh(){ rebuildAtIndex(Number(sliderEl.value)); }
  showIconsEl?.addEventListener("change", refresh);
  topNEl?.addEventListener("change", refresh);
  botNEl?.addEventListener("change", refresh);
  map.on("zoomend", refresh);

  if (timeline.length > 0){
    statusEl.textContent = `Loaded ${timeline.length} time steps ✅`;
    rebuildAtIndex(0);
  } else {
    statusEl.textContent = "Loaded but no frames found.";
    timeLabelEl.textContent = "No data";
  }
}

async function runGenerate(){
  try{
    generateBtn.disabled = true;
    statusEl.textContent = "Generating on Railway…";
    const genUrl = `${RAILWAY_BASE}/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25`;
    const res = await fetch(genUrl, { method: "POST" });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `Generate failed (${res.status})`);
    statusEl.textContent = `Generate OK ✅ (${j.size_mb} MB). Reloading…`;
    await loadHotspots();
  } catch(e){
    statusEl.textContent = "ERROR: " + (e?.message || String(e));
  } finally {
    generateBtn.disabled = false;
  }
}

generateBtn?.addEventListener("click", runGenerate);

loadHotspots().catch(err => {
  console.error(err);
  statusEl.textContent = "ERROR: " + err.message;
  timeLabelEl.textContent = "ERROR";
});