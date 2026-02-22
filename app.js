const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

/**
 * LABEL STRATEGY (to reduce crowding)
 * - Zoomed out: only show Highest/High (green/purple)
 * - Mid zoom: add Medium (blue), then Normal (sky)
 * - Zoomed in: show all (including yellow/red)
 * - Hard cap number of labels at low zoom to avoid clutter
 */

// When to start showing labels at all
const LABEL_ZOOM_MIN = 10;

// Bucket priority (higher first)
const BUCKET_PRIORITY = {
  green: 6,
  purple: 5,
  blue: 4,
  sky: 3,
  yellow: 2,
  red: 1,
};

// Which buckets allowed per zoom
function allowedBucketsForZoom(z) {
  if (z < 10) return new Set(); // none
  if (z < 12) return new Set(["green", "purple"]);                 // zoomed out
  if (z < 13) return new Set(["green", "purple", "blue"]);         // mid
  if (z < 14) return new Set(["green", "purple", "blue", "sky"]);  // closer
  return new Set(["green", "purple", "blue", "sky", "yellow", "red"]); // zoomed in
}

// Max labels allowed per zoom (hard cap to avoid overlap)
function maxLabelsForZoom(z) {
  if (z < 10) return 0;
  if (z < 12) return 22;   // very zoomed out: only show a few top zones
  if (z < 13) return 40;
  if (z < 14) return 65;
  return 120;              // still capped to avoid chaos
}

// Borough line (second line) only when zoomed in enough
const BOROUGH_LINE_ZOOM = 14;

// Shorten long names when not fully zoomed in
function maxCharsForZoom(z) {
  if (z < 12) return 12;
  if (z < 13) return 14;
  if (z < 14) return 18;
  return 40;
}

// ---------- Time helpers ----------
function parseIsoNoTz(iso) {
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
  return { Y, M, D, h, m, s };
}
function dowMon0FromIso(iso) {
  const { Y, M, D, h, m, s } = parseIsoNoTz(iso);
  const dt = new Date(Date.UTC(Y, M - 1, D, h, m, s));
  const dowSun0 = dt.getUTCDay();
  return dowSun0 === 0 ? 6 : dowSun0 - 1;
}
function minuteOfWeekFromIso(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  return dow_m * 1440 + (h * 60 + m);
}
function formatNYCLabel(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${names[dow_m]} ${hr12}:${mm} ${ampm}`;
}
function getNowNYCMinuteOfWeekRounded() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow_m = dowMap[map.weekday] ?? 0;

  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const total = dow_m * 1440 + hour * 60 + minute;
  return Math.floor(total / BIN_MINUTES) * BIN_MINUTES;
}
function cyclicDiff(a, b, mod) {
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}
function pickClosestIndex(minutesOfWeekArr, target) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < minutesOfWeekArr.length; i++) {
    const diff = cyclicDiff(minutesOfWeekArr[i], target, 7 * 1440);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------- Network ----------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 200)}`);
  }
}

// ---------- Bucket label ----------
function prettyBucket(b) {
  const m = {
    green: "Highest",
    purple: "High",
    blue: "Medium",
    sky: "Normal",
    yellow: "Below Normal",
    red: "Very Low / Avoid",
  };
  return m[b] || (b ?? "");
}

// ---------- Text helpers ----------
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}

// ---------- Label placement (inside polygon) ----------
/**
 * Uses polylabel to find a point inside the polygon (best interior label point).
 * Works with Polygon and MultiPolygon GeoJSON.
 * Returns [lat, lng] or null.
 */
function labelPointInside(geometry) {
  try {
    if (!geometry) return null;

    // helper: pick the biggest polygon from multipolygon (by outer ring bbox area)
    function polyBBoxArea(ring) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return (maxX - minX) * (maxY - minY);
    }

    if (geometry.type === "Polygon") {
      // polylabel expects: [ [ [x,y]...outer ], [hole]... ]
      const p = polylabel(geometry.coordinates, 1.0); // returns [x,y] = [lng,lat]
      return [p[1], p[0]];
    }

    if (geometry.type === "MultiPolygon") {
      let best = null;
      let bestArea = -1;

      for (const poly of geometry.coordinates) {
        const outer = poly?.[0];
        if (!outer || outer.length < 3) continue;
        const a = polyBBoxArea(outer);
        if (a > bestArea) {
          bestArea = a;
          best = poly;
        }
      }

      if (best) {
        const p = polylabel(best, 1.0);
        return [p[1], p[0]];
      }
    }

    // Fallback: turf pointOnFeature
    if (typeof turf !== "undefined") {
      const pt = turf.pointOnFeature({ type: "Feature", geometry, properties: {} });
      const [lng, lat] = pt.geometry.coordinates;
      return [lat, lng];
    }
  } catch (e) {
    // ignore and fall back
  }
  return null;
}

// ---------- Leaflet map ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let labelLayer = L.layerGroup().addTo(map);
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

// Popup
function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:900; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      <div><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function zoomClass(zoom) {
  const z = Math.max(7, Math.min(14, Math.round(zoom)));
  return `z${z}`;
}

function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  // clear old layers
  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }
  labelLayer.clearLayers();

  const zoomNow = map.getZoom();
  const allowed = allowedBucketsForZoom(zoomNow);
  const maxLabels = maxLabelsForZoom(zoomNow);
  const zClass = zoomClass(zoomNow);
  const maxChars = maxCharsForZoom(zoomNow);

  // Build geo polygons
  geoLayer = L.geoJSON(frame.polygons, {
    style: (feature) => {
      const st = feature?.properties?.style || {};
      return {
        color: st.color || st.fillColor || "#000",
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: st.fillColor || st.color || "#000",
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 300 });
    },
  }).addTo(map);

  // Pick which zones get labels (priority + cap)
  const feats = (frame.polygons?.features || []).slice();

  const labelCandidates = feats
    .map((f) => {
      const p = f.properties || {};
      const bucket = (p.bucket || "").trim();
      const pri = BUCKET_PRIORITY[bucket] ?? 0;
      const rating = Number(p.rating ?? 0);
      const pickups = Number(p.pickups ?? 0);
      return { f, pri, rating, pickups, bucket };
    })
    .filter((x) => x.pri > 0 && allowed.has(x.bucket))
    .sort((a, b) => {
      // strongest first: bucket priority, then rating, then pickups
      if (b.pri !== a.pri) return b.pri - a.pri;
      if (b.rating !== a.rating) return b.rating - a.rating;
      return b.pickups - a.pickups;
    })
    .slice(0, maxLabels);

  // Create label markers at interior points (inside polygon)
  for (const item of labelCandidates) {
    const props = item.f.properties || {};
    const name = (props.zone_name || "").trim();
    if (!name) continue;

    const pt = labelPointInside(item.f.geometry);
    if (!pt) continue;

    const zoneText = shortenLabel(name, maxChars);
    const borough = (props.borough || "").trim();
    const showBorough = zoomNow >= BOROUGH_LINE_ZOOM && borough;

    const html = `
      <div class="zone-label-flat ${zClass}">
        <div class="zn">${escapeHtml(zoneText)}</div>
        ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
      </div>
    `;

    const icon = L.divIcon({
      className: "", // we style inside HTML
      html,
      iconSize: null,
    });

    L.marker(pt, { icon, interactive: false }).addTo(labelLayer);
  }
}

async function loadFrame(idx) {
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

async function loadTimeline() {
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = Array.isArray(t) ? t : (t.timeline || []);
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

// Re-render labels on zoom (no network)
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Debounced slider
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

// Boot
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});