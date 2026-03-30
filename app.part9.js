(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;
  const core = window.TlcMapUiInternals || {};

  const recommendEl = core.getRecommendEl?.() || document.getElementById("recommendLine");
  const navBtn = core.getNavButton?.() || document.getElementById("navBtn");
  const onlineBadge = document.getElementById("onlineBadge");
  const weatherBadge = document.getElementById("weatherBadge");
  const wxCanvas = document.getElementById("wxCanvas");
  const wxCtx = wxCanvas ? wxCanvas.getContext("2d") : null;

  let recommendedDest = null;
  let wxState = { kind: "none", intensity: 0, isNight: false, tempF: null, label: "Weather…", lastLat: null, lastLng: null };
  let lastWeatherRefreshAt = 0;
  let wxParticles = [];
  let wxAnimRunning = false;
  let wxNextUpdateTimer = null;
  let lastRecommendationAudit = null;

  function setNavDisabled(disabled) {
    if (!navBtn) return;
    navBtn.classList.toggle("disabled", !!disabled);
  }
  function setNavDestination(dest) {
    recommendedDest = dest || null;
    if (!navBtn) return;

    if (!recommendedDest) {
      navBtn.href = "#";
      setNavDisabled(true);
      return;
    }

    const { lat, lng } = recommendedDest;
    navBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}&travelmode=driving`;
    setNavDisabled(false);
  }
  function hasRecommendedDestination() {
    return !!recommendedDest;
  }
  function updateRecommendation(frame) {
    if (!recommendEl) return;

    const userLatLng = core.getUserLatLng?.() || null;
    if (!userLatLng) {
      recommendEl.textContent = "Recommended: enable location to get suggestions";
      setNavDestination(null);
      lastRecommendationAudit = null;
      return;
    }

    const feats = frame?.polygons?.features || [];
    if (!feats.length) {
      recommendEl.textContent = "Recommended: …";
      setNavDestination(null);
      lastRecommendationAudit = null;
      return;
    }

    const allowed = new Set(["blue", "indigo", "purple", "green"]);
    const DIST_PENALTY_PER_MILE = 4.0;
    const BRONX_WASH_HEIGHTS_DIST_PENALTY_PER_MILE = 2.0;
    const modes = core.getSpecialModes?.() || {};
    const specialModesActive = modes.queensMode || modes.brooklynMode || modes.statenIslandMode || modes.bronxWashHeightsMode || modes.manhattanMode;
    const TIE_BREAK_THRESHOLD = 2.0;

    let best = null;

    for (const f of feats) {
      const props = f.properties || {};
      const geom = f.geometry;
      if (props.airport_excluded === true) continue;
      const modeTag = core.getActiveSpecialModeTagForFeature?.(props, geom);

      if (specialModesActive && modeTag == null) continue;

      const b = core.effectiveBucket?.(props, geom);
      if (!allowed.has(b)) continue;

      const rating = core.effectiveRating?.(props, geom);
      if (!Number.isFinite(rating)) continue;

      const center = core.geometryCenter?.(geom);
      if (!center) continue;

      const dMi = core.haversineMiles?.(userLatLng, center) || 0;
      const scoreSource = String(core.getVisibleScoreSourceForFeature?.(props, geom) || "");
      const distancePenaltyPerMile = modeTag === "queens"
        ? 5.0
        : (modeTag === "bronx_wash_heights"
          ? BRONX_WASH_HEIGHTS_DIST_PENALTY_PER_MILE
          : DIST_PENALTY_PER_MILE);
      let score = rating - dMi * distancePenaltyPerMile;

      const crowdingPenalty = Number(
        window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingPenalty?.(props.LocationID) ?? 0
      );
      if (Number.isFinite(crowdingPenalty) && crowdingPenalty > 0) {
        score -= crowdingPenalty;
      }

      if (!Number.isFinite(score)) continue;

      const churnPressure = Number(props.churn_pressure_n_shadow ?? NaN);
      const busyNextBase = Number(props.busy_next_base_n_shadow ?? NaN);
      const manhattanSaturation = Number(props.manhattan_core_saturation_proxy_n_shadow ?? NaN);

      const candidate = {
        score,
        dMi,
        rating,
        lat: center.lat,
        lng: center.lng,
        name: (props.zone_name || "").trim() || `Zone ${props.LocationID ?? ""}`,
        borough: (props.borough || "").trim(),
        usedQN: modeTag === "queens" && /^queens_/.test(scoreSource),
        usedBK: modeTag === "brooklyn" && /^brooklyn_/.test(scoreSource),
        usedSI: modeTag === "staten_island" && /^staten_island_/.test(scoreSource),
        usedMH: modeTag === "manhattan" && /^manhattan_/.test(scoreSource),
        usedBWH: modeTag === "bronx_wash_heights" && /^bronx_wash_heights_/.test(scoreSource),
        visibleScoreSource: scoreSource || "legacy_citywide",
        communityCrowding: window.TlcCommunityCrowdingModule?.getZoneCommunityCrowdingSnapshot?.(props.LocationID) || null,
        churnPressure: Number.isFinite(churnPressure) ? churnPressure : null,
        busyNextBase: Number.isFinite(busyNextBase) ? busyNextBase : null,
        manhattanSaturation: Number.isFinite(manhattanSaturation) ? manhattanSaturation : null,
      };

      if (!best || score > best.score) {
        best = candidate;
        continue;
      }

      if (best && Math.abs(score - best.score) <= TIE_BREAK_THRESHOLD) {
        const compareValues = [
          {
            next: candidate.churnPressure,
            current: best.churnPressure,
            lowerIsBetter: true,
          },
          {
            next: candidate.busyNextBase,
            current: best.busyNextBase,
            lowerIsBetter: false,
          },
        ];

        let tieDecision = 0;
        for (const item of compareValues) {
          if (!Number.isFinite(item.next) || !Number.isFinite(item.current)) continue;
          if (item.next === item.current) continue;
          tieDecision = item.lowerIsBetter
            ? (item.next < item.current ? 1 : -1)
            : (item.next > item.current ? 1 : -1);
          if (tieDecision !== 0) break;
        }

        if (modes.manhattanMode) {
          if (Number.isFinite(candidate.manhattanSaturation) && Number.isFinite(best.manhattanSaturation)) {
            if (candidate.manhattanSaturation !== best.manhattanSaturation) {
              tieDecision = candidate.manhattanSaturation < best.manhattanSaturation ? 1 : -1;
            }
          }
        }

        if (tieDecision > 0) {
          best = candidate;
        }
      }
    }

    if (!best) {
      recommendEl.textContent = "Recommended: no Blue+ zone nearby right now";
      setNavDestination(null);
      lastRecommendationAudit = null;
      return;
    }

    const distTxt = best.dMi >= 10 ? `${best.dMi.toFixed(0)} mi` : `${best.dMi.toFixed(1)} mi`;
    const bTxt = best.borough ? ` (${best.borough})` : "";
    const crowdingSuffix = (best.communityCrowding && (best.communityCrowding.bucket === "crowded" || best.communityCrowding.bucket === "heavy"))
      ? " • community crowding caution"
      : "";
    if (best.usedQN) {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Best Queens earnings score • Non-airport pocket • Safer from dead spots • Strong repeat-call pocket — ${distTxt}${crowdingSuffix}`;
    } else if (best.usedBWH) {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Bronx/Wash Heights earnings score ${best.rating} — ${distTxt}${crowdingSuffix}`;
    } else if (best.usedBK) {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Brooklyn earnings score ${best.rating} — ${distTxt}${crowdingSuffix}`;
    } else if (best.usedMH) {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Manhattan earnings score ${best.rating} — ${distTxt}${crowdingSuffix}`;
    } else if (best.usedSI) {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Staten Island earnings score ${best.rating} — ${distTxt}${crowdingSuffix}`;
    } else {
      recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Team Joseo score ${best.rating} — ${distTxt}${crowdingSuffix}`;
    }

    setNavDestination({ lat: best.lat, lng: best.lng });
    lastRecommendationAudit = {
      zoneName: best.name,
      borough: best.borough,
      rating: best.rating,
      distanceMiles: best.dMi,
      activeModeTag:
        best.usedQN ? "queens" :
        best.usedBK ? "brooklyn" :
        best.usedSI ? "staten_island" :
        best.usedMH ? "manhattan" :
        best.usedBWH ? "bronx_wash_heights" :
        "citywide",
      communityCrowding: best.communityCrowding || null,
      visibleScoreSource: best.visibleScoreSource || "legacy_citywide",
    };
  }

  function updateOnlineBadge(count, ghostedCount = 0) {
    if (!onlineBadge) return;
    const n = Number(count);
    const display = Number.isFinite(n) && n >= 0 ? n : 0;
    const g = Number(ghostedCount);
    const ghostedDisplay = Number.isFinite(g) && g >= 0 ? g : 0;
    const mainLine = `${display} online`;
    const txtEl = onlineBadge.querySelector(".onlineTxt") || onlineBadge.querySelector("#onlineTxt");
    if (txtEl) {
      txtEl.textContent = mainLine;
    } else {
      const textWrapEl = onlineBadge.querySelector(".onlineTextWrap");
      if (textWrapEl) {
        textWrapEl.textContent = mainLine;
      } else {
        onlineBadge.textContent = mainLine;
      }
    }
    const ghostTxtEl = onlineBadge.querySelector(".onlineGhostTxt");
    if (ghostTxtEl) {
      if (ghostedDisplay > 0) {
        ghostTxtEl.textContent = `${ghostedDisplay} Ghosted`;
        ghostTxtEl.hidden = false;
      } else {
        ghostTxtEl.hidden = true;
      }
    }
    onlineBadge.title = ghostedDisplay > 0
      ? `${display} online • ${ghostedDisplay} ghosted`
      : `${display} online`;
  }

  function applyBadgeIconModel() {
    const setIconMarkup = (iconEl, svgMarkup) => {
      if (!iconEl) return;
      iconEl.innerHTML = svgMarkup;
      iconEl.style.fontSize = "0";
      iconEl.style.display = "inline-grid";
      iconEl.style.placeItems = "center";
      iconEl.style.lineHeight = "1";
    };

    const onlineIconEl = onlineBadge?.querySelector?.(".onlineIcon");
    setIconMarkup(
      onlineIconEl,
      `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="8" cy="10" r="3.3" fill="currentColor"/><circle cx="16.3" cy="10.6" r="2.7" fill="currentColor" opacity="0.88"/><path d="M2.8 19a5.2 5.2 0 0 1 10.4 0M12 19a4.3 4.3 0 0 1 8.6 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
    );

    const weatherIconEl = weatherBadge?.querySelector?.(".wxIcon");
    setIconMarkup(
      weatherIconEl,
      `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="9" cy="8" r="3" fill="currentColor" opacity="0.95"/><path d="M9 4.4v1.4M5.4 8H4M14 8h1.4M6.5 5.6l-1-1M11.5 5.6l1-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.4 18.2h8a3.1 3.1 0 0 0 .1-6.2 4.4 4.4 0 0 0-8.2 1.7A2.4 2.4 0 0 0 8.4 18.2Z" fill="currentColor"/></svg>`
    );

    const pickupIconEl = document.querySelector("#pickupFab .pickupFabIcon");
    setIconMarkup(
      pickupIconEl,
      `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="display:block"><path d="m6.5 12.4 3.6 3.6 7.4-7.4" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    );

    enforceSaveButtonTheme();
  }

  function wxResizeCanvas() {
    if (!wxCanvas) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    wxCanvas.width = Math.floor(window.innerWidth * dpr);
    wxCanvas.height = Math.floor(window.innerHeight * dpr);
    wxCanvas.style.width = `${window.innerWidth}px`;
    wxCanvas.style.height = `${window.innerHeight}px`;
    if (wxCtx) wxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function wxDescribe(code) {
    const c = Number(code);
    if (c === 0) return { text: "Clear", icon: "☀️", kind: "none", intensity: 0 };
    if (c >= 1 && c <= 3) return { text: "Cloudy", icon: "⛅", kind: "none", intensity: 0 };
    if (c === 45 || c === 48) return { text: "Fog", icon: "🌫️", kind: "none", intensity: 0 };
    if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) {
      const intensity = c >= 65 || c >= 81 ? 0.85 : c >= 63 ? 0.65 : 0.45;
      return { text: "Rain", icon: "🌧️", kind: "rain", intensity };
    }
    if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) {
      const intensity = c >= 75 || c >= 86 ? 0.85 : 0.6;
      return { text: "Snow", icon: "❄️", kind: "snow", intensity };
    }
    if (c >= 95 && c <= 99) return { text: "Storm", icon: "⛈️", kind: "rain", intensity: 0.95 };
    return { text: "Weather", icon: "⛅", kind: "none", intensity: 0 };
  }
  function fFromC(c) {
    if (!Number.isFinite(c)) return null;
    return (c * 9) / 5 + 32;
  }
  function getWeatherIconMarkup(icon) {
    const iconMap = {
      "☀️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
      "⛅": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><circle cx="9" cy="8" r="3" fill="currentColor" opacity="0.95"/><path d="M9 4.4v1.4M5.4 8H4M14 8h1.4M6.5 5.6l-1-1M11.5 5.6l1-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8.4 18.2h8a3.1 3.1 0 0 0 .1-6.2 4.4 4.4 0 0 0-8.2 1.7A2.4 2.4 0 0 0 8.4 18.2Z" fill="currentColor"/></svg>`,
      "🌫️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M3 8.5h18M2.5 12h15M5 15.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
      "🌧️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M7.5 13.2h9a3.3 3.3 0 0 0 .1-6.6 4.7 4.7 0 0 0-8.8 1.8 2.8 2.8 0 0 0-.3 5.6Z" fill="currentColor"/><path d="M9 15.2l-1.1 2M12 15.8l-1.1 2M15 15.2l-1.1 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      "❄️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M12 4v16M5 8l14 8M19 8 5 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>`,
      "⛈️": `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" style="display:block"><path d="M7.5 12.8h9a3.3 3.3 0 0 0 .1-6.6 4.7 4.7 0 0 0-8.8 1.8 2.8 2.8 0 0 0-.3 5.6Z" fill="currentColor"/><path d="m12.2 13.2-1.6 3h1.5l-1 3 3-4h-1.8l1.3-2.4Z" fill="currentColor"/></svg>`,
    };
    return iconMap[icon] || icon;
  }

  function setWeatherBadge(icon, text) {
    if (!weatherBadge) return;
    const iconEl = weatherBadge.querySelector(".wxIcon");
    const txtEl = weatherBadge.querySelector(".wxTxt");
    if (iconEl) {
      const markup = getWeatherIconMarkup(icon);
      if (typeof markup === "string" && markup.startsWith("<svg")) {
        iconEl.innerHTML = markup;
        iconEl.style.fontSize = "0";
        iconEl.style.display = "inline-grid";
        iconEl.style.placeItems = "center";
        iconEl.style.lineHeight = "1";
      } else {
        iconEl.textContent = icon;
        iconEl.style.removeProperty("font-size");
        iconEl.style.removeProperty("display");
        iconEl.style.removeProperty("place-items");
        iconEl.style.removeProperty("line-height");
      }
    }
    if (txtEl) txtEl.textContent = text;
    weatherBadge.title = text;
  }
  function getWeatherLatLng() {
    const userLatLng = core.getUserLatLng?.() || null;
    const lat = userLatLng?.lat ?? 40.7128;
    const lng = userLatLng?.lng ?? -74.006;
    return { lat, lng };
  }
  function scheduleWeatherUpdateSoon() {
    const { lat, lng } = getWeatherLatLng();
    const lastLat = Number(wxState.lastLat);
    const lastLng = Number(wxState.lastLng);
    const lastPointValid = Number.isFinite(lastLat) && Number.isFinite(lastLng);
    const movedMiles = lastPointValid ? (core.haversineMiles?.({ lat: lastLat, lng: lastLng }, { lat, lng }) || 0) : Infinity;
    if (lastPointValid && movedMiles < 0.85) return;
    if (wxNextUpdateTimer) return;
    wxNextUpdateTimer = setTimeout(() => {
      wxNextUpdateTimer = null;
      updateWeatherNow().catch(() => {});
    }, 2500);
  }
  async function updateWeatherNow() {
    const { lat, lng } = getWeatherLatLng();
    if (document.hidden && Date.now() - lastWeatherRefreshAt < 10 * 60 * 1000) return;

    wxState.lastLat = lat;
    wxState.lastLng = lng;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lng)}` +
      `&current=temperature_2m,weather_code,is_day` +
      `&timezone=America%2FNew_York`;

    try {
      const data = await core.fetchJSON?.(url);
      const cur = data?.current || {};
      const tempC = Number(cur.temperature_2m ?? NaN);
      const tempF = fFromC(tempC);
      const code = cur.weather_code;
      const isDay = Number(cur.is_day ?? 1) === 1;

      const desc = wxDescribe(code);
      const label = `${desc.text}${tempF != null ? ` • ${Math.round(tempF)}°F` : ""}`;

      wxState.tempF = tempF;
      wxState.kind = desc.kind;
      wxState.intensity = desc.intensity;
      wxState.isNight = !isDay;
      wxState.label = label;

      core.setBodyTheme?.({ isNight: wxState.isNight, isSunny: desc.text === "Clear" });
      setWeatherBadge(desc.icon, label);

      updateWxParticlesForState();
      ensureWxAnimationRunning();
      lastWeatherRefreshAt = Date.now();
    } catch (e) {
      setWeatherBadge("⛅", "Weather unavailable");
    }
  }

  function updateWxParticlesForState() {
    if (!wxCanvas || !wxCtx) return;

    const kind = wxState.kind;
    const intensity = wxState.intensity;

    if (kind === "none" || intensity <= 0) {
      wxParticles = [];
      return;
    }

    const base = Math.floor((window.innerWidth * window.innerHeight) / 45000);
    const count = Math.max(40, Math.min(240, Math.floor(base * (kind === "rain" ? 2.4 : 1.6) * (0.6 + intensity))));

    wxParticles = [];
    for (let i = 0; i < count; i++) wxParticles.push(makeParticle(kind));
  }
  function makeParticle(kind) {
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (kind === "rain") {
      return {
        kind: "rain",
        x: Math.random() * w,
        y: Math.random() * h,
        vx: -1.2 - Math.random() * 1.2,
        vy: 10 + Math.random() * 10,
        len: 10 + Math.random() * 14,
        alpha: 0.12 + Math.random() * 0.12,
        w: 1.0,
      };
    }

    return {
      kind: "snow",
      x: Math.random() * w,
      y: Math.random() * h,
      vx: -0.7 + Math.random() * 1.4,
      vy: 1.2 + Math.random() * 2.2,
      r: 1.0 + Math.random() * 2.2,
      alpha: 0.14 + Math.random() * 0.18,
      drift: Math.random() * Math.PI * 2,
    };
  }
  function stepParticles() {
    if (!wxCanvas || !wxCtx) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    wxCtx.clearRect(0, 0, w, h);

    const intensity = wxState.intensity;

    if (wxState.kind === "rain") {
      wxCtx.lineCap = "round";
      for (const p of wxParticles) {
        wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
        wxCtx.lineWidth = p.w;

        wxCtx.beginPath();
        wxCtx.moveTo(p.x, p.y);
        wxCtx.lineTo(p.x + p.vx, p.y + p.len);
        wxCtx.strokeStyle = "#0a3d66";
        wxCtx.stroke();

        p.x += p.vx * (0.9 + intensity);
        p.y += p.vy * (0.85 + intensity);

        if (p.y > h + 30 || p.x < -30) {
          p.x = Math.random() * w;
          p.y = -20 - Math.random() * 200;
        }
      }
      wxCtx.globalAlpha = 1;
      return;
    }

    if (wxState.kind === "snow") {
      for (const p of wxParticles) {
        wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
        wxCtx.beginPath();
        wxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        wxCtx.fillStyle = "#ffffff";
        wxCtx.fill();

        p.drift += 0.03;
        p.x += (p.vx + Math.sin(p.drift) * 0.6) * (0.7 + intensity);
        p.y += p.vy * (0.7 + intensity);

        if (p.y > h + 20) {
          p.x = Math.random() * w;
          p.y = -10 - Math.random() * 150;
        }
        if (p.x < -20) p.x = w + 10;
        if (p.x > w + 20) p.x = -10;
      }
      wxCtx.globalAlpha = 1;
    }
  }
  function ensureWxAnimationRunning() {
    if (!wxCanvas || !wxCtx) return;

    const shouldRun = wxState.kind !== "none" && wxState.intensity > 0;
    if (!shouldRun) {
      wxAnimRunning = false;
      wxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      return;
    }
    if (wxAnimRunning) return;

    wxAnimRunning = true;

    const loop = () => {
      if (!wxAnimRunning) return;
      stepParticles();
      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }
  function getWeatherState() {
    return wxState;
  }

  window.getTeamJoseoRecommendationAudit = function getTeamJoseoRecommendationAudit() {
    return lastRecommendationAudit;
  };

  window.TlcMapUiModule = {
    setNavDisabled,
    setNavDestination,
    hasRecommendedDestination,
    updateRecommendation,
    updateOnlineBadge,
    applyBadgeIconModel,
    scheduleWeatherUpdateSoon,
    updateWeatherNow,
    getWeatherState
  };

  window.addEventListener("resize", wxResizeCanvas);
  wxResizeCanvas();
  applyBadgeIconModel();
  setInterval(() => { updateWeatherNow().catch(() => {}); }, 10 * 60 * 1000);
})();
