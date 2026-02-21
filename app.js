// =======================
// STRICT NYC FHV MAP (FINAL STABLE BUILD)
// Railway only
// Auto-generate if timeline not ready
// Proper retry handling
// Strict rating buckets
// NYC closest time-of-week slider init
// =======================

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function setStatus(msg){
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function nycTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getNYCParts(date = new Date()){
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter(p => p.type !== "literal")
      .map(p => [p.type, p.value])
  );

  const dowMap = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };

  return {
    dow: dowMap[parts.weekday] ?? 0,
    minuteOfDay: (Number(parts.hour) || 0)*60 + (Number(parts.minute) || 0)
  };
}

function timelineMinuteOfWeekNYC(iso){
  const p = getNYCParts(new Date(iso));
  return p.dow*1440 + p.minuteOfDay;
}

function addMinutesISO(iso, minutes){
  return new Date(new Date(iso).getTime() + minutes*60000).toISOString();
}

// ===== STRICT COLOR BUCKETS =====
function ratingToColor(r){
  r = clamp(Number(r||0),1,100);
  if(r<=25) return "#d32f2f";     // Red Avoid
  if(r<=50) return "#81d4fa";     // Sky Normal
  if(r<=75) return "#1976d2";     // Blue Medium
  return "#2e7d32";               // Green Best
}

// Normalize rating to 1–100
function getRating1to100(p){
  let v = p?.rating ?? p?.score ?? p?.value ?? null;
  if(v==null) return null;
  v = Number(v);
  if(!Number.isFinite(v) || v<=0) return null;

  if(v<=1) return Math.round(1+99*v);  // 0–1
  if(v<=10) return Math.round(v*10);   // 1–10
  return clamp(Math.round(v),1,100);   // already 1–100
}

function getRailwayBase(){
  const base = window.RAILWAY_BASE_URL;
  if(!base) return null;
  return base.replace(/\/+$/,"");
}

const BASE = getRailwayBase();
const BIN_MINUTES = 20;

// ===== MAP =====
const map = L.map("map").setView([40.72,-73.98],12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null,{
  pane:"polys",
  style:(f)=>{
    const r = getRating1to100(f?.properties);
    if(r!=null){
      return { stroke:false, fillColor:ratingToColor(r), fillOpacity:0.72 };
    }
    return { stroke:false, fillColor:"#e0e0e0", fillOpacity:0.2 };
  }
}).addTo(map);

// ===== UI =====
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnNow = document.getElementById("btnNow");
const btnGenerate = document.getElementById("btnGenerate");

let timeline = [];

// ===== API =====
async function apiGET(path){
  return fetch(`${BASE}${path}`,{cache:"no-store"});
}

async function apiPOST(path){
  return fetch(`${BASE}${path}`,{method:"POST"});
}

// ===== GENERATE + WAIT UNTIL READY =====
async function ensureTimelineReady(){

  // Try timeline first
  let res = await apiGET("/timeline");

  if(res.ok){
    const data = await res.json();
    timeline = Array.isArray(data)?data:(data.timeline||[]);
    return;
  }

  // If not ready -> generate
  setStatus("Generating…");
  await apiPOST("/generate?bin_minutes=20");

  // Retry timeline up to 15 times
  for(let i=0;i<15;i++){
    await sleep(800);
    res = await apiGET("/timeline");
    if(res.ok){
      const data = await res.json();
      timeline = Array.isArray(data)?data:(data.timeline||[]);
      return;
    }
  }

  throw new Error("Timeline failed after generate");
}

// ===== FRAME LOAD =====
async function loadFrame(i){
  const res = await apiGET(`/frame/${i}`);
  if(!res.ok) throw new Error("Frame failed");
  return res.json();
}

// ===== SLIDER INIT =====
function setSliderBounds(){
  slider.min=0;
  slider.max=Math.max(0,timeline.length-1);
  slider.step=1;
}

function pickIndexClosestToNow(){
  const now = getNYCParts();
  const nowM = now.dow*1440+now.minuteOfDay;
  const week=10080;
  let best=0;
  let bestDiff=Infinity;

  for(let i=0;i<timeline.length;i++){
    const tM = timelineMinuteOfWeekNYC(timeline[i]);
    const diff = Math.min(
      Math.abs(tM-nowM),
      week-Math.abs(tM-nowM)
    );
    if(diff<bestDiff){ bestDiff=diff; best=i; }
  }
  return best;
}

// ===== RENDER =====
function render(frame){
  const t=frame?.time;
  if(t){
    const end=addMinutesISO(t,BIN_MINUTES);
    timeLabel.textContent=
      nycTimeLabel(t)+" – "+
      nycTimeLabel(end).replace(/^[A-Za-z]{3}\s/,"")+" (NYC)";
  }

  polyLayer.clearLayers();
  if(frame?.polygons) polyLayer.addData(frame.polygons);
}

// ===== MAIN BOOT =====
async function boot(){
  if(!BASE){
    setStatus("Missing Railway URL");
    return;
  }

  try{
    setStatus("Loading…");
    await ensureTimelineReady();

    if(!timeline.length){
      setStatus("No timeline data");
      return;
    }

    setSliderBounds();

    const idx = pickIndexClosestToNow();
    const frame = await loadFrame(idx);
    slider.value=idx;
    render(frame);

    setStatus(`Loaded ${timeline.length} windows`);
  }
  catch(e){
    console.error(e);
    setStatus("Load failed (timeline)");
  }
}

slider.addEventListener("input", async ()=>{
  try{
    const frame = await loadFrame(slider.value);
    render(frame);
  }catch(e){
    setStatus("Load failed");
  }
});

btnNow?.addEventListener("click", boot);
btnGenerate?.addEventListener("click", boot);

boot();