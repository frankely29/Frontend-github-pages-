// =======================
// TLC Hotspot Map - app.js (stable + phone-friendly)
// - ALWAYS colors polygons (even if JSON style changes)
// - Polygons = rating color (Gray→Red→Yellow→Green)
// - Icons = extremes only (✅ Top / ❌ Bottom) to avoid mixed signals
// - NYC time label forced
// - Slider throttled for iPhone
// - Loads data from Railway (/download) so GitHub size limit doesn't matter
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

// NYC time label
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// Rating (1-100) => color buckets (Gray very low, Red avoid, Yellow medium, Green good)
// You told me: "Grey very low activity, red worse than grey, yellow medium, green good"
// So we make Gray = very low, Red = avoid, Yellow = medium, Green = good.
function ratingToFill(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return { fill:"#9b9b9b", cat:"gray", op:0.25 };

  // Buckets (tuneable):
  // 1-15 very low => Gray
  // 16-35 avoid => Reds
  // 36-65 medium => Yellows
  // 66-100 good => Greens (stronger green higher rating)
  if (r <= 15){
    return { fill:"#9b9b9b", cat:"gray", op:0.20 };
  }
  if (r <= 35){
    // red intensity within 16..35
    const t = clamp01((r - 16) / (35 - 16));
    const rr = Math.round(lerp(214, 140, t));
    const gg = Math.round(lerp(0,   0,   t));
    const bb = Math.round(lerp(0,   0,   t));
    return { fill:`rgb(${rr},${gg},${bb})`, cat:"red", op:0.35 };
  }
  if (r <= 65){
    // yellow/orange within 36..65
    const t = clamp01((r - 36) / (65 - 36));
    const rr = Math.round(lerp(255, 255, t));
    const gg = Math.round(lerp(215, 176, t));
    const bb = Math.round(lerp(0,   80,  t));
    return { fill:`rgb(${rr},${gg},${bb})`, cat:"yellow", op:0.40 };
  }
  // greens within 66..100
  const t = clamp01((r - 66) / (100 - 66));
  const rr = Math.round(lerp(70,  0,   t));
  const gg = Math.round(lerp(176,176, t)); // keep strong green
  const bb = Math.round(lerp(80,  50,  t));
  return { fill:`rgb(${rr},${gg},${bb})`, cat:"green", op:0.45 };
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

// --- Railway base URL must exist ---
const RAILWAY_BASE_URL = (window.RAILWAY_BASE_URL || "").replace(/\/+$/,"");
if (!RAILWAY_BASE_URL){
  console.error("Missing window.RAILWAY_BASE_URL in index.html");
  // show error on label
  const tl = document.getElementById("timeLabel");
  if (tl) tl.textContent = "ERROR: Missing window.RAILWAY_BASE_URL in index.html";
}

// Leaflet map
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes: polygons under markers
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;
map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    // If your JSON already includes a style, we still "normalize" to prevent the “all red” bug.
    // We trust rating first, then fallback to p.style.fillColor.
    const rating = (p.rating ?? p.rating_1_100 ?? p.rating1_100 ?? p.r);
    const bucket = ratingToFill(rating);

    const fillColor = bucket.fill || (p.style?.fillColor ?? "#9b9b9b");
    const fillOpacity = Number.isFinite(bucket.op) ? bucket.op : (p.style?.fillOpacity ?? 0.35);

    return {
      color: "#1b1b1b",
      weight: 2,
      fillColor,
      fillOpacity
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    // If builder included popup HTML, keep it
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });

    // fallback popup
    if (!p.popup){
      const rating = (p.rating ?? p.rating_1_100 ?? "n/a");
      const pickups = (p.pickups ?? "n/a");
      const zone = (p.zone ?? p.Zone ?? p.name ?? "Zone");
      const borough = (p.borough ?? p.Borough ?? "Unknown");
      layer.bindPopup(
        `<div style="font-family:Arial;font-size:13px">
          <div style="font-weight:900">${zone}</div>
          <div style="color:#666">${borough}</div>
          <hr style="margin:6px 0">
          <div><b>Rating:</b> ${rating}/100</div>
          <div><b>Pickups:</b> ${pickups}</div>
        </div>`,
        { maxWidth: 360 }
      );
    }
  }
}).addTo(map);

const markerLayer = L.layerGroup([], { pane: "markers" }).addTo(map);

let timeline = [];
let dataByTime = new Map();

// Deterministic small jitter to reduce icon overlap (same zone always same offset)
function jitterLatLng(lat, lng, keyStr){
  let h = 0;
  for (let i=0;i<keyStr.length;i++) h = (h*31 + keyStr.charCodeAt(i)) >>> 0;
  // circle jitter in meters (0..120m)
  const meters = 40 + (h % 80); // 40..119m
  const angle = (h % 360) * (Math.PI/180);
  const dLat = (meters * Math.cos(angle)) / 111320; // approx
  const dLng = (meters * Math.sin(angle)) / (111320 * Math.cos(lat * Math.PI/180));
  return [lat + dLat, lng + dLng];
}

function buildIcon(tag){
  // ✅ = green ring, ❌ = red ring, big and readable
  const isTop = (tag === "TOP");
  const ring = isTop ? "#00b050" : "#d60000";
  const symbol = isTop ? "✓" : "✕";
  const symColor = isTop ? "#00b050" : "#d60000";

  const html = `
    <div style="
      width:28px;height:28px;border-radius:999px;
      background:rgba(255,255,255,0.92);
      border:3px solid ${ring};
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 1px 6px rgba(0,0,0,0.25);
      font-weight:900;font-size:18px;line-height:18px;color:${symColor};
    ">${symbol}</div>
  `;
  return L.divIcon({ html, className:"", iconSize:[28,28], iconAnchor:[14,14] });
}

function clearMap(){
  polyLayer.clearLayers();
  markerLayer.clearLayers();
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  clearMap();

  // Polygons
  // bundle.polygons should be a FeatureCollection or array of features
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // Icons (extremes only)
  const iconsOn = document.getElementById("iconsToggle").checked;
  if (!iconsOn) return;

  const topN = Math.max(0, Math.min(200, Number(document.getElementById("topN").value || 0)));
  const botN = Math.max(0, Math.min(200, Number(document.getElementById("botN").value || 0)));

  // We expect bundle.markers OR we derive extremes from polygons if markers missing.
  let markers = Array.isArray(bundle.markers) ? bundle.markers.slice() : [];

  if (!markers.length && bundle.polygons && bundle.polygons.features){
    // derive from polygon features if needed
    const feats = bundle.polygons.features
      .map(f => {
        const p = f.properties || {};
        const rating = Number(p.rating ?? p.rating_1_100);
        const lat = Number(p.lat ?? p.centroid_lat);
        const lng = Number(p.lng ?? p.centroid_lng);
        return { f, p, rating, lat, lng };
      })
      .filter(x => Number.isFinite(x.rating));

    feats.sort((a,b) => b.rating - a.rating);

    const top = feats.slice(0, topN).map(x => ({ tag:"TOP", rating:x.rating, ...x.p }));
    const bot = feats.slice(Math.max(0, feats.length - botN)).map(x => ({ tag:"BOT", rating:x.rating, ...x.p }));

    markers = top.concat(bot);
  }

  // Draw markers, but enforce “no conflicting signals”:
  // TOP markers only if the zone is in green bucket.
  // BOT markers only if the zone is in red/gray bucket.
  for (const m of markers){
    const lat = Number(m.lat);
    const lng = Number(m.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rating = Number(m.rating ?? m.rating_1_100 ?? m.rating1_100);
    const bucket = ratingToFill(rating);

    const wantTop = (m.tag === "TOP" || m.tag === "GOOD" || m.tag === "Very Good" || m.tag === "TOP_GOOD");
    const wantBot = (m.tag === "BOT" || m.tag === "BAD" || m.tag === "Very Low" || m.tag === "BOTTOM_BAD");

    if (wantTop && bucket.cat !== "green") continue;
    if (wantBot && (bucket.cat !== "red" && bucket.cat !== "gray")) continue;

    const tag = wantTop ? "TOP" : "BOT";
    const icon = buildIcon(tag);

    const keyStr = String(m.zone_id ?? m.LocationID ?? m.PULocationID ?? (m.zone || "") + ":" + tag);
    const [jl, jg] = jitterLatLng(lat, lng, keyStr);

    const zone = (m.zone ?? m.Zone ?? "Zone");
    const borough = (m.borough ?? m.Borough ?? "Unknown");
    const pickups = (m.pickups ?? "n/a");
    const avg_driver_pay = m.avg_driver_pay;
    const avg_tips = m.avg_tips;

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        <div style="color:#666; margin-bottom:4px;">${borough} — <b>${tag === "TOP" ? "TOP (Good)" : "BOTTOM (Avoid)"}</b></div>
        <div><b>Rating:</b> <span style="font-weight:900;">${Number.isFinite(rating) ? rating : "n/a"}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(avg_tips)}</div>
      </div>
    `;

    L.marker([jl, jg], { icon, pane:"markers" })
      .bindPopup(popup, { maxWidth: 360 })
      .addTo(markerLayer);
  }
}

async function fetchHotspots(){
  const statusLine = document.getElementById("statusLine");

  // Always use Railway data (NOT GitHub) so you never hit the 25MB limit
  const url = `${RAILWAY_BASE_URL}/download?ts=${Date.now()}`;

  const res = await fetch(url, { cache:"no-store" });
  if (!res.ok){
    let msg = `Failed to fetch hotspots (${res.status})`;
    try{
      const t = await res.text();
      msg += `: ${t.slice(0,140)}`;
    } catch {}
    throw new Error(msg);
  }

  const payload = await res.json();
  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  if (statusLine){
    statusLine.classList.remove("bad");
    statusLine.textContent = `Loaded ${timeline.length} steps from Railway ✅`;
  }
}

function setupSlider(){
  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });
}

function setupPanel(){
  const panel = document.getElementById("panel");
  const body = document.getElementById("panelBody");
  const btn = document.getElementById("minBtn");

  btn.addEventListener("click", () => {
    const minimized = panel.classList.toggle("minimized");
    body.classList.toggle("hidden", minimized);
    btn.textContent = minimized ? "Max" : "Min";
  });

  // Re-render on control changes
  const rerender = () => rebuildAtIndex(Number(document.getElementById("slider").value || 0));
  document.getElementById("iconsToggle").addEventListener("change", rerender);
  document.getElementById("topN").addEventListener("change", rerender);
  document.getElementById("botN").addEventListener("change", rerender);
}

async function main(){
  setupPanel();

  const timeLabel = document.getElementById("timeLabel");
  const statusLine = document.getElementById("statusLine");

  try{
    await fetchHotspots();
  } catch (err){
    console.error(err);
    if (statusLine){
      statusLine.classList.add("bad");
      statusLine.textContent = "Data load failed ❌";
    }
    timeLabel.textContent = "ERROR: " + err.message;
    return;
  }

  setupSlider();

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    timeLabel.textContent = "No timeline found in data";
  }
}

main();