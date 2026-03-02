/* =========================================================
   NEW: RADIO BUTTONS (Hot 97 + Alofoke FM)
   ---------------------------------------------------------
   - No hard-coded stream URLs (they change)
   - We resolve streams at runtime using Radio Browser API:
     /json/stations/search?name=...
   - Mobile Safari requires a USER gesture to start audio,
     so play only happens when you tap the buttons.
   ========================================================= */

const btnHot97 = document.getElementById("btnHot97");
const btnAlofoke = document.getElementById("btnAlofoke");
const radioStatusEl = document.getElementById("radioStatus");

// One shared audio element (so only one station plays at a time)
const radioAudio = new Audio();
radioAudio.preload = "none";
radioAudio.crossOrigin = "anonymous"; // best effort

let radioNow = null; // "hot97" | "alofoke" | null

function setRadioStatus(text) {
  if (radioStatusEl) radioStatusEl.textContent = text;
}

function setRadioUI() {
  if (btnHot97) btnHot97.classList.toggle("on", radioNow === "hot97");
  if (btnAlofoke) btnAlofoke.classList.toggle("on", radioNow === "alofoke");

  // Button text: show pause when active
  if (btnHot97) btnHot97.textContent = (radioNow === "hot97") ? "⏸ Hot 97" : "▶︎ Hot 97";
  if (btnAlofoke) btnAlofoke.textContent = (radioNow === "alofoke") ? "⏸ Alofoke FM" : "▶︎ Alofoke FM";
}

async function fetchJSONNoStore(url) {
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return JSON.parse(text);
}

// Resolve a playable stream URL from Radio Browser search results
async function resolveRadioBrowserStream({ name, countrycode }) {
  // Using the documented search endpoint
  // Example: https://stations.radioss.app/json/stations/search?name=Hot%2097&limit=20&hidebroken=true
  // Docs: /json/stations/search with parameters like name, limit, hidebroken. (See Radio Browser API docs.)
  const base = "https://stations.radioss.app/json/stations/search";
  const qs = new URLSearchParams();
  qs.set("name", name);
  qs.set("limit", "25");
  qs.set("hidebroken", "true");
  if (countrycode) qs.set("countrycode", countrycode);

  const url = `${base}?${qs.toString()}`;
  const arr = await fetchJSONNoStore(url);

  if (!Array.isArray(arr) || arr.length === 0) return null;

  // Prefer higher bitrate + common codecs, and a resolved URL if available
  const scored = arr
    .map((s) => {
      const codec = (s.codec || "").toLowerCase();
      const br = Number(s.bitrate || 0);
      const u = (s.url_resolved || s.url || "").trim();
      if (!u) return null;

      // Basic preference scoring
      let score = 0;
      if (codec.includes("mp3")) score += 40;
      if (codec.includes("aac")) score += 30;
      if (codec.includes("ogg")) score += 10;
      score += Math.min(30, br / 10); // bitrate helps but capped

      // Nudge if name matches strongly
      const nm = (s.name || "").toLowerCase();
      if (nm.includes(name.toLowerCase().replace(/\s+/g, ""))) score += 10;

      return { url: u, name: s.name || name, codec: s.codec || "", bitrate: br, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

async function playStation(which) {
  try {
    // Toggle off if already playing this one
    if (radioNow === which) {
      radioAudio.pause();
      radioAudio.src = "";
      radioNow = null;
      setRadioStatus("Radio: off");
      setRadioUI();
      return;
    }

    // Stop anything currently playing
    radioAudio.pause();
    radioAudio.src = "";
    radioNow = which;
    setRadioUI();
    setRadioStatus("Radio: loading…");

    // Resolve streams by station name
    let resolved = null;

    if (which === "hot97") {
      // Hot 97 is NYC (US). Countrycode "US" helps results.
      resolved = await resolveRadioBrowserStream({ name: "Hot 97", countrycode: "US" });
    } else if (which === "alofoke") {
      // Alofoke is Dominican Republic. Countrycode "DO" helps results.
      resolved = await resolveRadioBrowserStream({ name: "Alofoke", countrycode: "DO" });
      // Fallback if name search misses:
      if (!resolved) resolved = await resolveRadioBrowserStream({ name: "Alofoke FM", countrycode: "DO" });
    }

    if (!resolved || !resolved.url) {
      radioNow = null;
      setRadioUI();
      setRadioStatus("Radio: stream not found");
      return;
    }

    // Try to play
    radioAudio.src = resolved.url;
    radioAudio.volume = 0.9;

    // IMPORTANT: must be called from user gesture (button click) on iOS
    await radioAudio.play();

    const meta = `${resolved.name}${resolved.codec ? ` (${resolved.codec}` : ""}${resolved.bitrate ? ` ${resolved.bitrate}kbps` : ""}${resolved.codec ? ")" : ""}`;
    setRadioStatus(`Playing: ${meta}`);
    setRadioUI();
  } catch (e) {
    console.warn("Radio play failed:", e);
    // Most common iOS issue: not allowed without user gesture, or stream blocks CORS
    setRadioStatus("Radio: failed to play (try again)");
    radioNow = null;
    setRadioUI();
  }
}

// Keep UI accurate if stream ends/errors
radioAudio.addEventListener("ended", () => {
  radioNow = null;
  setRadioUI();
  setRadioStatus("Radio: ended");
});
radioAudio.addEventListener("error", () => {
  radioNow = null;
  setRadioUI();
  setRadioStatus("Radio: error");
});

if (btnHot97) {
  btnHot97.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnHot97.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  btnHot97.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    playStation("hot97");
  });
}

if (btnAlofoke) {
  btnAlofoke.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnAlofoke.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  btnAlofoke.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    playStation("alofoke");
  });
}

setRadioUI();