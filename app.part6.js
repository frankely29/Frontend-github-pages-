(function() {
  const runtime = window.FrontendRuntime || null;
  const runtimePolling = runtime?.polling || null;

  const MAP_IDENTITY_MODE_NAME = 'name';
  const MAP_IDENTITY_MODE_AVATAR = 'avatar';
  const MAP_IDENTITY_IMG_SIZE = 160;
  const MAP_IDENTITY_CROP_VIEW_SIZE = 220;
  const MAP_IDENTITY_MIN_ZOOM = 10;
  const MAP_IDENTITY_MAX_ZOOM = 16;
  let mapIdentityTempAvatarDataUrl = '';
  let mapIdentitySavedAvatarDataUrl = '';
  let mapIdentityCropState = null;

  function clampMapIdentity(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function normalizeMapIdentityMode(mode) {
    return mode === MAP_IDENTITY_MODE_AVATAR ? MAP_IDENTITY_MODE_AVATAR : MAP_IDENTITY_MODE_NAME;
  }

  function safeMapAvatarUrl(url) {
    const resolver = window.resolveMapAvatarUrl;
    if (typeof resolver === 'function') return resolver(url);
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('data:image/')) return trimmed;
    if (trimmed.startsWith('blob:')) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) {
      const proto = (typeof window !== 'undefined' && window.location?.protocol) ? window.location.protocol : 'https:';
      return `${proto}${trimmed}`;
    }
    if (/^(javascript|vbscript|data):/i.test(trimmed)) return '';

    const runtimeBase = (typeof window !== 'undefined' && window.FrontendRuntime?.resolveApiBase)
      ? String(window.FrontendRuntime.resolveApiBase() || '').trim()
      : '';
    const globalApiBase = (typeof window !== 'undefined' && window.API_BASE !== undefined)
      ? String(window.API_BASE || '').trim()
      : '';
    const runtimeConfigApiBase = (typeof window !== 'undefined' && window.__TLC_RUNTIME_CONFIG__?.apiBase !== undefined)
      ? String(window.__TLC_RUNTIME_CONFIG__.apiBase || '').trim()
      : '';
    const fallbackApiBase = (typeof window !== 'undefined' && window.__TLC_DEFAULT_API_BASE__ !== undefined)
      ? String(window.__TLC_DEFAULT_API_BASE__ || '').trim()
      : '';
    const hostFallback = (() => {
      if (typeof window === 'undefined') return '';
      const host = String(window.location?.hostname || '').toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
        const resolvedHost = host === '127.0.0.1' ? '127.0.0.1' : 'localhost';
        return `${window.location.protocol}//${resolvedHost}:3000`;
      }
      return '';
    })();
    const apiBase = (runtimeBase || globalApiBase || runtimeConfigApiBase || fallbackApiBase || hostFallback || '').replace(/\/+$/, '');
    if (!apiBase) return '';

    const relativePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return `${apiBase}${relativePath}`;
  }

  function mapIdentityPlaceholderHTML() {
    return `
      <div class="mapPresenceAvatar mapPresenceAvatarPlaceholder" aria-label="No profile photo">
        <svg viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false">
          <circle cx="12" cy="8" r="4"></circle>
          <path d="M4 20c0-4.2 3.6-7 8-7s8 2.8 8 7"></path>
        </svg>
      </div>
    `;
  }

  function syncMapIdentitySavedAvatarCache() {
    const serverAvatar = safeMapAvatarUrl(window?.me?.avatar_url);
    if (serverAvatar) {
      mapIdentitySavedAvatarDataUrl = serverAvatar;
      return serverAvatar;
    }
    return '';
  }

  function mapIdentityZoomT(zoomValue) {
    const z = Number.isFinite(zoomValue)
      ? zoomValue
      : (Number.isFinite(window?.map?.getZoom?.()) ? window.map.getZoom() : 12);
    const t = (z - MAP_IDENTITY_MIN_ZOOM) / (MAP_IDENTITY_MAX_ZOOM - MAP_IDENTITY_MIN_ZOOM);
    return clampMapIdentity(t, 0, 1);
  }

  function mapIdentityVisualConfig(zoomValue) {
    const t = mapIdentityZoomT(zoomValue);
    const smooth = t * t * (3 - 2 * t);
    const emphasize = Math.pow(smooth, 0.9);
    const avatarPx = +(18 + (52 - 18) * emphasize).toFixed(2);
    const tipSizePx = +(4 + (8 - 4) * emphasize).toFixed(2);
    const crownPx = clampMapIdentity(Math.round(avatarPx * 0.76), 18, 32);
    const podiumPx = clampMapIdentity(Math.round(avatarPx * 0.40), 12, 18);
    return {
      avatarPx,
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.36),
      rootPx: +(30 + (66 - 30) * emphasize).toFixed(2),
      tipSizePx,
      tipOrbitPx: +((avatarPx * 0.5) - 1 + (tipSizePx * 0.1)).toFixed(2),
      initialsFontPx: +(8 + (18 - 8) * emphasize).toFixed(2),
      badgeFontPx: +(13 + (17 - 13) * emphasize).toFixed(2),
      arrowBodyPx: +(18 + (27 - 18) * t).toFixed(2),
      arrowLeftRightPx: +(4.5 + (7 - 4.5) * t).toFixed(2),
      arrowAccentPx: +(10 + (14 - 10) * t).toFixed(2)
    };
  }

  function mapIdentityBadgeSizeConfig(avatarPx) {
    const baseAvatar = Number(avatarPx);
    const safeAvatarPx = Number.isFinite(baseAvatar) ? baseAvatar : 28;
    const crownPx = clampMapIdentity(Math.round(safeAvatarPx * 0.76), 18, 32);
    const podiumPx = clampMapIdentity(Math.round(safeAvatarPx * 0.40), 12, 18);
    return {
      crownPx,
      podiumPx,
      crownLiftPx: Math.round(crownPx * 0.36)
    };
  }

  function shouldUseAvatarLabel(mode, avatarUrl) {
    return normalizeMapIdentityMode(mode) === MAP_IDENTITY_MODE_AVATAR && !!safeMapAvatarUrl(avatarUrl);
  }

  function mapIdentityBadgeOverlayHTML({ badgeCode, avatarPx, code }) {
    const meta = window.leaderboardBadgeMeta?.(badgeCode || code) || {
      code: '',
      label: '',
      toneClass: ''
    };
    if (!meta.code) return '';
    const badgeSizeCfg = mapIdentityBadgeSizeConfig(avatarPx);
    const size = meta.code === 'crown' ? badgeSizeCfg.crownPx : badgeSizeCfg.podiumPx;
    return `<span class="mapIdentityBadgeOverlay mapBadgeWearable ${meta.toneClass}" aria-label="${escapeHtml(meta.label)}">${window.renderLeaderboardBadgeSvg?.(meta.code, { size, mapWearable: true, compact: true }) || ''}</span>`;
  }

  function mapIdentityPresenceCoreHTML({ markerClass, name, avatarUrl, cfg, leaderboardBadgeCode, orbitMeta = null, directionId = '' }) {
    const safeAvatar = safeMapAvatarUrl(avatarUrl);
    const avatarHTML = safeAvatar
      ? `<div class="mapPresenceAvatar"><img src="${escapeHtml(safeAvatar)}" alt="avatar" loading="lazy"></div>`
      : mapIdentityPlaceholderHTML();
    const orbitAttrs = mapIdentityOrbitDataAttrs(orbitMeta);
    return `
      <div class="mapPresenceOrbit ${markerClass}" data-map-identity-label="1" data-map-presence-orbit="1" ${orbitAttrs}>
        <div class="mapPresenceRoot">
          <div class="mapPresenceShell" style="width:${cfg.avatarPx}px;height:${cfg.avatarPx}px;">
            ${avatarHTML}
          </div>
          <span class="mapPresenceBadgeOverlay">${mapIdentityBadgeOverlayHTML({ badgeCode: leaderboardBadgeCode, avatarPx: cfg.avatarPx })}</span>
        </div>
      </div>
    `;
  }

  function mapIdentityOverlayWrapHTML(coreHTML, badgeMeta = {}) {
    return `<div class="mapIdentityWrap"><div class="mapIdentityCore">${coreHTML}</div>${mapIdentityBadgeOverlayHTML(badgeMeta)}</div>`;
  }

  function mapIdentityAvatarLabelHTML(avatarUrl, className, styleText, badgeMeta = {}) {
    const safeUrl = escapeHtml(avatarUrl);
    return mapIdentityOverlayWrapHTML(
      `<div class="${className}" style="${styleText}" data-map-identity-label="1"><img src="${safeUrl}" alt="avatar" loading="lazy"></div>`,
      badgeMeta
    );
  }

  function mapIdentityOverlapBadgeHTML(overlapMeta) {
    const count = Number(overlapMeta?.count);
    const leader = !!overlapMeta?.leader;
    if (!Number.isFinite(count) || count <= 1 || !leader) return '';
    const extra = Math.max(0, Math.round(count) - 1);
    const text = extra > 0 ? `+${extra}` : `${Math.round(count)}`;
    return `<span class="mapIdentityOverlapBadge" style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.7);font-size:10px;line-height:14px;font-weight:700;text-align:center;pointer-events:none;">${escapeHtml(text)}</span>`;
  }

  function mapIdentityRenderSelfLabel({ name, avatarUrl, mode, zoom, leaderboardBadgeCode, orbitMeta = null, overlapMeta = null }) {
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const cfg = mapIdentityVisualConfig(zoom);
    const effectiveOrbitMeta = orbitMeta || overlapMeta || null;
    const slotSide = String(effectiveOrbitMeta?.side || '').trim();
    const sideClass = slotSide ? ` slot-${slotSide}` : '';
    return `<div class="selfIdentitySlot${sideClass}" data-map-identity-label="1">${mapIdentityPresenceCoreHTML({ markerClass: 'mapPresenceSelf', name: safeName, avatarUrl, cfg, leaderboardBadgeCode, directionId: 'navPresenceDirectionRot', orbitMeta: effectiveOrbitMeta })}</div>`;
  }

  function mapIdentityOrbitStyleText(orbitMeta, zoomValue) {
    const count = Number(orbitMeta?.count);
    if (!Number.isFinite(count) || count <= 1) return '';

    const angleRad = (Number(orbitMeta?.angleDeg) || 0) * (Math.PI / 180);
    const cfg = mapIdentityVisualConfig(zoomValue);
    const ring = Math.max(0, Number(orbitMeta?.ring) || 0);

    const baseRadiusPx = Math.max(16, (cfg.rootPx * 0.54));
    const ringGapPx = Math.max(12, cfg.rootPx * 0.42);

    const radius = baseRadiusPx + (ring * ringGapPx);
    const dx = +(Math.cos(angleRad) * radius).toFixed(2);
    const dy = +(Math.sin(angleRad) * radius).toFixed(2);

    return `--marker-slot-x:${dx}px;--marker-slot-y:${dy}px;`;
  }

  function mapIdentityOrbitDataAttrs(orbitMeta) {
    const idx = Number(orbitMeta?.index);
    const count = Number(orbitMeta?.count);
    const angle = Number(orbitMeta?.angleDeg);
    const ring = Number(orbitMeta?.ring);
    return [
      `data-orbit-index="${Number.isFinite(idx) ? Math.round(idx) : 0}"`,
      `data-orbit-count="${Number.isFinite(count) ? Math.round(count) : 1}"`,
      `data-orbit-angle="${Number.isFinite(angle) ? +angle.toFixed(2) : 0}"`,
      `data-orbit-ring="${Number.isFinite(ring) ? Math.max(0, Math.round(ring)) : 0}"`
    ].join(' ');
  }

  function mapIdentityReadOrbitMeta(slot) {
    if (!slot?.dataset) return null;
    return {
      index: Number(slot.dataset.orbitIndex) || 0,
      count: Number(slot.dataset.orbitCount) || 1,
      angleDeg: Number(slot.dataset.orbitAngle) || 0,
      ring: Number(slot.dataset.orbitRing) || 0
    };
  }

  function mapIdentityApplyOrbitStyleToSlot(slot) {
    if (!slot) return;
    const orbitMeta = mapIdentityReadOrbitMeta(slot);
    const orbitStyle = mapIdentityOrbitStyleText(orbitMeta, map?.getZoom?.());
    slot.style.removeProperty('--identity-slot-x');
    slot.style.removeProperty('--identity-slot-y');
    if (!orbitStyle) {
      slot.style.removeProperty('--marker-slot-x');
      slot.style.removeProperty('--marker-slot-y');
      return;
    }
    orbitStyle.split(';').forEach((chunk) => {
      const [prop, value] = chunk.split(':');
      if (!prop || !value) return;
      slot.style.setProperty(prop.trim(), value.trim());
    });
  }

  function mapIdentityRefreshOrbitSlots() {
    document.querySelectorAll('.mapPresenceOrbit[data-map-presence-orbit="1"]').forEach((slot) => {
      mapIdentityApplyOrbitStyleToSlot(slot);
    });
  }

  function mapIdentityRenderDriverLabel({ name, avatarUrl, mode, zoom, orbitMeta = null, overlapMeta = null, leaderboardBadgeCode }) {
    const effectiveOrbitMeta = orbitMeta || overlapMeta || null;
    const safeName = (String(name || 'Driver').trim() || 'Driver');
    const cfg = mapIdentityVisualConfig(zoom);
    const slotSide = String(effectiveOrbitMeta?.side || '').trim();
    const sideClass = slotSide ? ` slot-${slotSide}` : '';
    return `<div class="otherDrvIdentitySlot${sideClass}" data-map-identity-label="1">${mapIdentityPresenceCoreHTML({ markerClass: 'mapPresenceOther', name: safeName, avatarUrl, cfg, leaderboardBadgeCode, orbitMeta: effectiveOrbitMeta })}</div>`;
  }

  function mapIdentityApplySelfOrbit(orbitMeta) {
    const slot = document.querySelector('#navWrap .mapPresenceOrbit[data-map-presence-orbit="1"]');
    if (!slot) return;
    const sideClasses = ['slot-E', 'slot-W', 'slot-N', 'slot-S', 'slot-NE', 'slot-NW', 'slot-SE', 'slot-SW'];
    const slotHost = slot.closest('.selfIdentitySlot');
    sideClasses.forEach((cls) => slotHost?.classList.remove(cls));

    const slotSide = String(orbitMeta?.side || '').trim();
    const orbitStyle = mapIdentityOrbitStyleText(orbitMeta, map?.getZoom?.());
    slot.setAttribute('data-orbit-index', Number.isFinite(orbitMeta?.index) ? `${Math.round(orbitMeta.index)}` : '0');
    slot.setAttribute('data-orbit-count', Number.isFinite(orbitMeta?.count) ? `${Math.round(orbitMeta.count)}` : '1');
    slot.setAttribute('data-orbit-angle', Number.isFinite(orbitMeta?.angleDeg) ? `${+orbitMeta.angleDeg.toFixed(2)}` : '0');
    slot.setAttribute('data-orbit-ring', Number.isFinite(orbitMeta?.ring) ? `${Math.max(0, Math.round(orbitMeta.ring))}` : '0');

    if (!orbitStyle) {
      slot.style.removeProperty('--marker-slot-x');
      slot.style.removeProperty('--marker-slot-y');
      return;
    }

    orbitStyle.split(';').forEach((chunk) => {
      const [prop, value] = chunk.split(':');
      if (!prop || !value) return;
      slot.style.setProperty(prop.trim(), value.trim());
    });

    if (slotSide) slotHost?.classList.add(`slot-${slotSide}`);
  }

  function mapIdentityApplyZoomStyles(zoomValue) {
    const cfg = mapIdentityVisualConfig(zoomValue);
    const rootStyle = document.documentElement?.style;
    if (rootStyle) {
      rootStyle.setProperty('--map-ident-arrow-body', `${cfg.arrowBodyPx}px`);
      rootStyle.setProperty('--map-ident-arrow-left-right', `${cfg.arrowLeftRightPx}px`);
      rootStyle.setProperty('--map-ident-arrow-accent', `${cfg.arrowAccentPx}px`);
      rootStyle.setProperty('--map-ident-badge-font', `${cfg.badgeFontPx}px`);
      rootStyle.setProperty('--map-presence-root-px', `${cfg.rootPx}px`);
      rootStyle.setProperty('--map-presence-avatar', `${cfg.avatarPx}px`);
      rootStyle.setProperty('--map-presence-initials-font', `${cfg.initialsFontPx}px`);
      rootStyle.setProperty('--map-presence-tip-size', `${cfg.tipSizePx}px`);
      rootStyle.setProperty('--map-presence-tip-orbit', `${cfg.tipOrbitPx}px`);
      rootStyle.setProperty('--map-presence-badge-font', `${cfg.badgeFontPx}px`);
      rootStyle.setProperty('--map-presence-badge-scale', `${(cfg.rootPx / 54).toFixed(3)}`);
      rootStyle.setProperty('--map-crown-size', `${cfg.crownPx}px`);
      rootStyle.setProperty('--map-podium-size', `${cfg.podiumPx}px`);
      rootStyle.setProperty('--map-crown-lift', `${cfg.crownLiftPx}px`);
    }
    document.querySelectorAll('#navWrap, .otherDrvWrap').forEach((el) => {
      el.style.width = `${cfg.rootPx}px`;
      el.style.height = `${cfg.rootPx}px`;
    });
    document.querySelectorAll('.mapPresenceRoot').forEach((el) => {
      el.style.width = `${cfg.rootPx}px`;
      el.style.height = `${cfg.rootPx}px`;
    });
    document.querySelectorAll('.mapPresenceShell').forEach((el) => {
      el.style.width = `${cfg.avatarPx}px`;
      el.style.height = `${cfg.avatarPx}px`;
    });
    mapIdentityRefreshOrbitSlots();
  }

  function readMapIdentityFile(file) {
    if (!file) throw new Error('No file selected');
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Could not read image'));
      fr.readAsDataURL(file);
    });
  }

  async function loadMapIdentityImage(url) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image'));
      el.src = url;
    });
  }

  function closeMapIdentityCropper() {
    const modal = document.getElementById('mapIdentityCropModal');
    if (modal) modal.remove();
    mapIdentityCropState = null;
  }

  function applyMapIdentityCropTransform() {
    if (!mapIdentityCropState) return;
    const { imgEl, image, viewport, baseScale, zoom, tx, ty } = mapIdentityCropState;
    const scale = baseScale * zoom;
    const scaledW = (image.naturalWidth || image.width) * scale;
    const scaledH = (image.naturalHeight || image.height) * scale;
    const maxX = Math.max(0, (scaledW - viewport) / 2);
    const maxY = Math.max(0, (scaledH - viewport) / 2);
    mapIdentityCropState.tx = clampMapIdentity(tx, -maxX, maxX);
    mapIdentityCropState.ty = clampMapIdentity(ty, -maxY, maxY);
    imgEl.style.transform = `translate(-50%, -50%) translate(${mapIdentityCropState.tx}px, ${mapIdentityCropState.ty}px) scale(${scale})`;
  }

  async function exportMapIdentityCropDataUrl() {
    if (!mapIdentityCropState) throw new Error('Crop state not ready');
    const { image, viewport, baseScale, zoom, tx, ty } = mapIdentityCropState;
    const scale = baseScale * zoom;
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    let sx = (iw / 2) + ((-viewport / 2) - tx) / scale;
    let sy = (ih / 2) + ((-viewport / 2) - ty) / scale;
    let sw = viewport / scale;
    let sh = viewport / scale;
    sw = Math.min(sw, iw);
    sh = Math.min(sh, ih);
    sx = clampMapIdentity(sx, 0, iw - sw);
    sy = clampMapIdentity(sy, 0, ih - sh);
    const canvas = document.createElement('canvas');
    canvas.width = MAP_IDENTITY_IMG_SIZE;
    canvas.height = MAP_IDENTITY_IMG_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, MAP_IDENTITY_IMG_SIZE, MAP_IDENTITY_IMG_SIZE);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function openMapIdentityCropper(file) {
    const imageUrl = await readMapIdentityFile(file);
    const image = await loadMapIdentityImage(imageUrl);
    closeMapIdentityCropper();
    const modal = document.createElement('div');
    modal.id = 'mapIdentityCropModal';
    modal.className = 'mapIdentityCropModal';
    modal.style.zIndex = '11050';
    modal.innerHTML = `
      <div class="mapIdentityCropCard">
        <div class="mapIdentityCropTitle">Crop photo</div>
        <div class="mapIdentityCropViewport" id="mapIdentityCropViewport">
          <img id="mapIdentityCropImage" alt="Crop preview">
        </div>
        <input id="mapIdentityCropZoom" class="mapIdentityCropZoom" type="range" min="1" max="3" step="0.01" value="1">
        <div class="mapIdentityCropActions">
          <button id="mapIdentityCropCancel" class="chipBtn">Cancel</button>
          <button id="mapIdentityCropConfirm" class="chipBtn">Use Photo</button>
        </div>
      </div>
    `;
    const card = modal.querySelector('.mapIdentityCropCard');
    if (card) card.style.zIndex = '11051';
    document.body.appendChild(modal);
    const imgEl = modal.querySelector('#mapIdentityCropImage');
    const zoomEl = modal.querySelector('#mapIdentityCropZoom');
    const viewportEl = modal.querySelector('#mapIdentityCropViewport');
    imgEl.src = imageUrl;
    const baseScale = Math.max(
      MAP_IDENTITY_CROP_VIEW_SIZE / (image.naturalWidth || image.width),
      MAP_IDENTITY_CROP_VIEW_SIZE / (image.naturalHeight || image.height)
    );
    mapIdentityCropState = {
      image,
      imgEl,
      zoomEl,
      viewport: MAP_IDENTITY_CROP_VIEW_SIZE,
      baseScale,
      zoom: 1,
      tx: 0,
      ty: 0,
      pointerId: null,
      startX: 0,
      startY: 0,
      startTx: 0,
      startTy: 0
    };
    applyMapIdentityCropTransform();

    viewportEl.addEventListener('pointerdown', (evt) => {
      if (!mapIdentityCropState) return;
      mapIdentityCropState.pointerId = evt.pointerId;
      mapIdentityCropState.startX = evt.clientX;
      mapIdentityCropState.startY = evt.clientY;
      mapIdentityCropState.startTx = mapIdentityCropState.tx;
      mapIdentityCropState.startTy = mapIdentityCropState.ty;
      viewportEl.setPointerCapture(evt.pointerId);
    });
    viewportEl.addEventListener('pointermove', (evt) => {
      if (!mapIdentityCropState || mapIdentityCropState.pointerId !== evt.pointerId) return;
      mapIdentityCropState.tx = mapIdentityCropState.startTx + (evt.clientX - mapIdentityCropState.startX);
      mapIdentityCropState.ty = mapIdentityCropState.startTy + (evt.clientY - mapIdentityCropState.startY);
      applyMapIdentityCropTransform();
    });
    const endDrag = (evt) => {
      if (!mapIdentityCropState || mapIdentityCropState.pointerId !== evt.pointerId) return;
      mapIdentityCropState.pointerId = null;
    };
    viewportEl.addEventListener('pointerup', endDrag);
    viewportEl.addEventListener('pointercancel', endDrag);
    zoomEl.addEventListener('input', () => {
      if (!mapIdentityCropState) return;
      mapIdentityCropState.zoom = clampMapIdentity(Number(zoomEl.value) || 1, 1, 3);
      applyMapIdentityCropTransform();
    });

    modal.querySelector('#mapIdentityCropCancel')?.addEventListener('click', (e) => {
      e.preventDefault();
      closeMapIdentityCropper();
    });
    modal.querySelector('#mapIdentityCropConfirm')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const processed = await exportMapIdentityCropDataUrl();
        mapIdentityTempAvatarDataUrl = processed;
        mapIdentitySavedAvatarDataUrl = processed;
        await saveMapIdentityUpdate({ avatar_url: processed, map_identity_mode: MAP_IDENTITY_MODE_AVATAR });
        closeMapIdentityCropper();
      } catch (err) {
        alert(err?.message || 'Image processing failed.');
      }
    });
  }

  function mapIdentityCurrentState() {
    const meObj = (typeof window !== 'undefined' && window.me) ? window.me : {};
    const serverAvatar = syncMapIdentitySavedAvatarCache();
    return {
      mode: normalizeMapIdentityMode(meObj?.map_identity_mode),
      avatarUrl: serverAvatar || mapIdentitySavedAvatarDataUrl || mapIdentityTempAvatarDataUrl,
      name: meObj?.display_name || 'Driver'
    };
  }

  function renderMapIdentityProfileSection() {
    const host = document.getElementById('profileMapIdentitySection');
    if (!host) return;
    const state = mapIdentityCurrentState();
    const hasAvatar = !!state.avatarUrl;
    host.innerHTML = `
      <div class="mapIdentitySection">
        <div class="mapIdentityTitle">Map Identity</div>
        <div class="mapIdentityModes">Map markers use photo only.</div>
        <div class="mapIdentityAvatarRow">
          <div class="mapIdentityPreviewWrap">
            ${hasAvatar ? `<img id="mapIdentityPreview" class="mapIdentityPreview" src="${escapeHtml(state.avatarUrl)}" alt="Profile preview">` : `<div id="mapIdentityPreview" class="mapIdentityPreview mapIdentityPreviewFallback">${escapeHtml((state.name || 'D')[0].toUpperCase())}</div>`}
          </div>
          <div class="mapIdentityActions">
            <button id="mapIdentityChoosePhoto" class="chipBtn">Choose Photo</button>
            <button id="mapIdentityRemovePhoto" class="chipBtn">Remove Photo</button>
          </div>
        </div>
        <input id="mapIdentityFileInput" type="file" accept="image/*" hidden>
      </div>
    `;
  }

  async function saveMapIdentityUpdate(updates) {
    if (typeof authHeaderOK === 'function' && !authHeaderOK()) return;
    if (typeof updateMeProfile !== 'function') return;
    await updateMeProfile(updates);
    if (typeof refreshNavNameLabel === 'function') refreshNavNameLabel();
    renderMapIdentityProfileSection();
  }

  function initMapIdentityProfileControls() {
    renderMapIdentityProfileSection();
    const fileInput = document.getElementById('mapIdentityFileInput');
    document.getElementById('mapIdentityChoosePhoto')?.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput?.click();
    });
    document.getElementById('mapIdentityRemovePhoto')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Remove your saved photo?')) return;
      mapIdentitySavedAvatarDataUrl = '';
      mapIdentityTempAvatarDataUrl = '';
      await saveMapIdentityUpdate({ avatar_url: '', map_identity_mode: MAP_IDENTITY_MODE_AVATAR });
    });
    fileInput?.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        await openMapIdentityCropper(f);
      } catch (err) {
        alert(err?.message || 'Image processing failed.');
      } finally {
        fileInput.value = '';
      }
    });
  }

  function clearMapIdentityTempState() {
    closeMapIdentityCropper();
    const fileInput = document.getElementById('mapIdentityFileInput');
    if (fileInput) fileInput.value = '';
  }

  function getDockViewport() {
    return document.getElementById('dockViewport');
  }

  function getDockTrack() {
    return document.getElementById('dockTrack');
  }

  function getDockSaveButton() {
    return document.getElementById('pickupFab');
  }

  function updateDockScrollHints() {
    const dock = document.getElementById('dock');
    const viewport = getDockViewport();
    if (!dock || !viewport) return;
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const leftVisible = viewport.scrollLeft > 2;
    const rightVisible = viewport.scrollLeft < (maxScroll - 2);
    dock.classList.toggle('dock-can-scroll-left', leftVisible);
    dock.classList.toggle('dock-can-scroll-right', rightVisible);
  }

  function centerDockOnSave({ behavior = 'smooth' } = {}) {
    const viewport = getDockViewport();
    const saveBtn = getDockSaveButton();
    if (!viewport || !saveBtn) return;

    const viewportWidth = viewport.clientWidth;
    const targetLeft = saveBtn.offsetLeft + (saveBtn.offsetWidth / 2) - (viewportWidth / 2);
    const maxScroll = Math.max(0, viewport.scrollWidth - viewportWidth);
    const clampedLeft = Math.max(0, Math.min(maxScroll, targetLeft));
    viewport.scrollTo({ left: clampedLeft, behavior });
  }

  let dockAutoCenterTimer = 0;
  let dockPointerIsDown = false;

  function cancelDockAutoCenter() {
    if (!dockAutoCenterTimer) return;
    clearTimeout(dockAutoCenterTimer);
    dockAutoCenterTimer = 0;
  }

  function scheduleDockAutoCenter() {
    cancelDockAutoCenter();
    dockAutoCenterTimer = setTimeout(() => {
      if (dockPointerIsDown) {
        scheduleDockAutoCenter();
        return;
      }
      dockAutoCenterTimer = 0;
      centerDockOnSave({ behavior: 'smooth' });
    }, 10000);
  }

  function scrollDockByStep(direction) {
    const viewport = getDockViewport();
    if (!viewport) return;
    const step = Math.max(120, Math.round(viewport.clientWidth * 1.2));
    viewport.scrollBy({ left: direction * step, behavior: 'smooth' });
    scheduleDockAutoCenter();
  }

  function initDockScroller() {
    const viewport = getDockViewport();
    const leftHint = document.getElementById('dockScrollHintLeft');
    const rightHint = document.getElementById('dockScrollHintRight');
    if (!viewport) return;

    let rafId = 0;
    const scheduleHintUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateDockScrollHints();
      });
    };

    const handleDockInteraction = () => {
      cancelDockAutoCenter();
      scheduleHintUpdate();
      scheduleDockAutoCenter();
    };

    const beginDockDrag = () => {
      dockPointerIsDown = true;
      handleDockInteraction();
    };

    const endDockDrag = () => {
      if (!dockPointerIsDown) return;
      dockPointerIsDown = false;
      scheduleDockAutoCenter();
    };

    viewport.addEventListener('scroll', handleDockInteraction, { passive: true });
    viewport.addEventListener('pointerdown', beginDockDrag, { passive: true });
    viewport.addEventListener('touchstart', beginDockDrag, { passive: true });
    viewport.addEventListener('wheel', handleDockInteraction, { passive: true });
    window.addEventListener('pointerup', endDockDrag, { passive: true });
    window.addEventListener('pointercancel', endDockDrag, { passive: true });
    window.addEventListener('touchend', endDockDrag, { passive: true });
    window.addEventListener('touchcancel', endDockDrag, { passive: true });
    window.addEventListener('resize', () => {
      centerDockOnSave({ behavior: 'auto' });
      scheduleHintUpdate();
      scheduleDockAutoCenter();
    });

    leftHint?.addEventListener('click', () => scrollDockByStep(-1));
    rightHint?.addEventListener('click', () => scrollDockByStep(1));

    centerDockOnSave({ behavior: 'auto' });
    scheduleHintUpdate();
    scheduleDockAutoCenter();
    setTimeout(() => {
      centerDockOnSave({ behavior: 'auto' });
      scheduleHintUpdate();
    }, 120);
  }

  window.TlcMapIdentityModule = {
    mapIdentityRenderSelfLabel,
    mapIdentityRenderDriverLabel,
    mapIdentityApplyZoomStyles,
    mapIdentityApplySelfOrbit,
    initMapIdentityProfileControls,
    clearMapIdentityTempState,
    initDockScroller,
    updateDockScrollHints,
    scrollDockByStep,
    safeMapAvatarUrl
  };

  window.safeMapAvatarUrl = safeMapAvatarUrl;
  window.initDockScroller = initDockScroller;
  window.updateDockScrollHints = updateDockScrollHints;
  window.scrollDockByStep = scrollDockByStep;

  initDockScroller();
})();
