# Frontend Changelog

## 2026-06-10

### "Backup All Trips" — owner-only, moved into the Admin Portal
- The trip backup is now an **admin-portal** action restricted to the **account owner (main admin)**, and it backs up **every user's** pickup trips (not just your own). The old **💾 Backup My Trips** button in the Modes panel (and its `/me/pickups/export` call) was removed.
- New **⬇️ Backup All Trips** button in the Admin Portal header (`admin.panel.js`), shown only when `me.is_account_owner` is true. Calls the owner-gated `GET /admin/pickups/export_all`, reads the response as a Blob, and downloads `all-pickup-trips-YYYY-MM-DD.zip` (CSV + JSON, every user's trips with `user_id`/`email`). Shows "Preparing… → ✅ Saved!" and alerts on failure.
- Relies on `/me` now returning `is_account_owner` for the visibility gate; the backend also enforces owner-only (403), so the button is owner-only on both ends.

### Pickup/hotspot overlay: fill the whole city once, in the background
- After the fast local load, the overlay now **progressively loads the rest of the city once** and keeps it until a page refresh — so panning/zooming shows citywide hotspots without the old constant re-pulling. A single citywide request can't be used (the backend scores every zone and times out), so instead `fillCitywidePickupHotspotsOnce()` walks a grid of **20 bounded tiles** over the NYC service area (`PICKUP_TILE_DEG = 0.12°`, each ~the size of the fast local fetch), **nearest-first** from the current view, staggered ~250 ms apart.
  - Tile results **accumulate** into the overlay (deduped by zone / micro-hotspot key, dots capped at `PICKUP_CITY_ITEM_CAP`) and re-render as each tile lands, so the city fills in around you over a few seconds.
  - **Additive + defensive:** it's seeded with the local load and triggered only after it succeeds; a slow tile is aborted (`PICKUP_TILE_TIMEOUT_MS`) and a failed tile is skipped — if the background fill ever hiccups, the local hotspots from the one-shot load stay put. It runs **once per refresh** (`pickupCitywideFillStarted`); a page refresh re-runs it with current data.
- This sits on top of the once-per-refresh behavior below (no per-move re-pull, no 12s poll).

### Pickup/hotspot overlay loads once per refresh (stop re-pulling on every map move)
- The pickup **hotspot overlay** (`/events/pickups/recent` in `app.part10.js`) was re-querying the database on **every `moveend` and `zoomend`** (viewport-scoped) and polling every **12s** — constant network + work as you pan, even though the hotspots barely change. It now **loads once per page refresh and stays put**:
  - **One bounded request:** `pickupOverlayQueryPath()` fetches a **generous area around the current view** in a single call — a `~0.05°` (~3.5 mi) buffer (`PICKUP_ONESHOT_BUFFER_DEG`). So panning within the loaded area shows the already-loaded hotspots without re-fetching. (A first attempt used a full citywide no-bbox pull, but that makes the backend score every zone and times out — the hotspots never rendered — so it's bounded to a generous local area instead.)
  - **One-shot guards:** a `pickupOverlayLoadedOnce` flag set after the first successful load makes `refreshPickupOverlay`, `schedulePickupOverlayRefresh`, and `schedulePickupPoll` all no-op thereafter (and stops the 12s poll). Failures before the first success still retry, so the single load is robust.
  - **`app.js`:** removed the `schedulePickupOverlayRefresh()` calls from the `moveend` / `zoomend` handlers (presence still refreshes on move; hotspots no longer do).
- Net: the overlay is pulled a single time after a refresh and no longer consumes resources re-pulling/re-rendering as the map moves. A page refresh re-loads it.

### Strategic points show only during their prime / let-out window
- All time-based map overlays now **hide their pins entirely outside their prime pickup window** and appear (pulsing) only during it — so the map shows only where it's worth being *right now*, instead of a full board of always-on markers. The change is a per-layer `filter` keyed to the same boolean that already drives each overlay's pulse, so an icon is visible if and only if it is pulsing. All evaluate on the existing 1-minute tick, so points appear/disappear as the clock crosses into/out of prime.
  - **Dollar-flag long-trip hotspots** (`long-trip-hotspots-pins.feature.js`): the gold "$" flag and its associated building sprites (hotels / hospitals / offices) now show only while the hotspot is in its `dim_schedule.prime` window. Non-prime flags are dropped from the WebGL layer (`syncFlagLayer` filters on `primeForHotspot`), and the buildings layer gets `filter ["==", ["get","prime"], true]` (each building carries its parent hotspot's `prime`). The pole-base pulse was already prime-only.
  - **Major hospital & hotel landmarks** (`major-buildings.feature.js`): icons + type labels now carry a `prime` flag (hotels = checkout mornings, hospitals = the discharge window) and are filtered on it; a new `syncIcons()` rebuilds the icon source every minute so they show/hide as time moves. Previously the icons were always on and only the pulse was time-gated.
  - **Nightlife & dining districts** (`nightlife-districts.feature.js`): the magenta cocktail pin + label are filtered to the district's let-out window (`prime` / `prime_weekend`), matching the pulse.
  - **City events** (`city-events.feature.js`): concert / sports / convention pins + labels show only while the event is **letting out** (the best-pickup surge), and are hidden while upcoming or in progress.
- Not affected: driver-placed "45+ Trips" flags (a manual annotation with no prime schedule) stay visible, and non-strategic layers (presence avatars, etc.) are unchanged.

### Nightlife pulse: visible at the city-overview zoom, and bolder
- The nightlife / dining district let-out pulse was gated to zoom ≥11 and rendered faintly (glow at ~0.12–0.22 opacity, shrunk to 0.7× at low zoom), so it was invisible at a city-wide view and read as very dim even zoomed in. Now it's a clear magenta beacon from the overview scale:
  - **Zoom gate** `MIN_ZOOM` 11 → 9 — pins + pulse appear at the city-overview zoom (the type label still holds at 13 to avoid clutter).
  - **Full-size pulse at low zoom**: `pulseZoomScale` floor 0.7 → 1.0 (at zoom ≤11) so the rings/glow are not shrunk at city scale.
  - **Brighter**: glow opacity ~0.12–0.22 → ~0.22–0.36 and radius 12 → 18; ring peak opacity 0.55 → 0.85, stroke-width 2.5 → 3.5; cocktail-pin size curve bumped (low end 0.4 → 0.5).

### Nightlife pins render above the zone colors
- The zone choropleth re-adds its fill layers on top of the map whenever the style reloads (the aggressive zone backfill), which buried the nightlife pins + pulse **underneath** the zone colors — they were being drawn, then painted over. `nightlife-districts.feature.js` was the only point overlay missing a **z-order keeper**; the dollar-flag, hotspot, major-building, and city-event overlays already re-lift themselves on `styledata`. Added one for nightlife, with a twist: it's **zone-aware** — it only re-lifts when a `*zone*` layer is actually rendered above it, so it settles just above the zones and never ping-pongs with the other overlays' keepers (which lift themselves to the very top on the same event).

### Nightlife pin + pulse scale down when zoomed out
- The pin and pulse were held near full size even at the city-overview zoom, making them feel oversized there. They now **scale with zoom** — compact when zoomed out, growing as you zoom in — so they read as tidy beacons at city scale and full detail up close. The reduction is strongest at the far-out zooms and tapers to near-unchanged once zoomed in:
  - `pulseZoomScale` floor 1.0 (≤z11) → a smooth ramp **0.5 (z9) → 1.4 (z16)**, so the glow/rings roughly halve at city zoom (glow ~18px → ~9–11px).
  - Pin `icon-size` low end trimmed (`9: 0.5 → 0.3`, `11: 0.58 → 0.42`, …), tapering to a near-identical `18: 1.0 → 0.95` up close.

### Nightlife pulse: one slower ring for a smoother feel
- The let-out pulse used **two** expanding rings (offset half a cycle) on a fast 1.5s loop, which read as busy. Simplified to a single, calmer ring:
  - **One ring** instead of two (dropped `nld-pulse-ring2` entirely — layer, animation, and z-order entry).
  - **Slower**: `PULSE_PERIOD_MS` 1500 → 2200 so it expands and fades gently.
  - **Smaller/tighter**: `PULSE_R_MAX` 30 → 20 so the ring stays a compact inner halo around the pin rather than sweeping wide.
  - The soft glow underneath is unchanged.

### Other point overlays adopt the same single-ring pulse
- Replicated the nightlife pulse feel across the other ring-pulse overlays so the whole map pulses consistently — **one** slower, smaller, bolder ring instead of two fast ones. Each keeps its own glow color/character; only the ring changed (dropped each overlay's `…-pulse-ring2` layer, animation call, and z-order entry; `PULSE_PERIOD_MS` → 2200, `PULSE_R_MAX` → 20, ring stroke-width 2.5 → 3.5, ring opacity → `0.85·(1−t)`):
  - **City events** (`city-events.feature.js`) — the letting-out surge pulse.
  - **Major hospital & hotel landmarks** (`major-buildings.feature.js`) — keeps the per-type stroke color.
  - **Dollar-flag long-trip hotspots** (`long-trip-hotspots-pins.feature.js`) — the gold pole-base pulse.
- The driver-placed "45+ Trips" flags have no ring pulse and are untouched.

## 2026-06-09

### Nightlife & dining district pickup pulse
- New `nightlife-districts.feature.js` map overlay (registered in `index.html`'s `__TLC_LOCAL_JS_ASSETS__`). Reads `GET /nightlife_districts` and drops one **magenta cocktail-glass pin** per district, distinct from the gold dollar-flag pins and orange event pins.
- Pulses a magenta glow + two expanding rings during each district's **let-out window** — dinner let-out through last call, later on Fri/Sat — computed client-side from the backend `dim_schedule` (`prime` weeknight / `prime_weekend`; hour ranges wrap past midnight). Pins dim by time-of-day and brighten/pulse at let-out; a tap shows the district's venues, a "best pickup" state chip, and best-hours.
- Self-contained IIFE mirroring the long-trip-hotspots feature's wiring (apiBase / authHeaders / waitForMap, 5-min refresh, 1-min dim tick, GL circle pulse). No backend calendar needed — nightlife never closes.

### Dollar-flag shrinks more when zoomed out
- Flags still felt too big at the city-overview zooms. Lowered the `flagZoomScale` zoom-out end so they shrink harder when you zoom out: **z≤9 `0.60 → 0.30`**, z13 `0.85 → 0.65`, and the zoomed-in cap `1.10 → 1.05` (so close-up size is basically unchanged). Net: far-out flags are about **half** their previous size and stay small/uncluttered across the overview zooms, then grow to full size as you zoom in to street level.

### Dollar-flag size restored to the original (the rename must not resize it)
- The "45+" → two-line rename had unintentionally grown the flag (`FLAG_W_CSS` 34 → 44, `FLAG_H_CSS` 42 → 48), so it looked too big / cluttered when zoomed out. **Restored the original 34 × 42 footprint** so the flag scales down exactly as before when you zoom out — the `flagZoomScale` curve (0.60× far out → 1.10× zoomed in) was never the problem and is unchanged. The two-line "45+"/"Trips" label is kept and auto-sizes to the smaller pennant; the drag-marker badge went back to ~44×40.

### Dollar-flag relabeled "45+" → "45+ / Trips" (two lines, narrow)
- The driver-placed long-trip flag now shows the label on **two stacked lines — "45+" over "Trips"** — so the flag stays **narrow** instead of stretching into one wide banner. The pole sits near the left (`POLE_FRAC`) with a compact pennant to its right; the lng/lat anchor stays the **pole base**, so flags pin to exactly the same map point as before.
- WebGL atlas path (`drawFlagInto`): `FLAG_W_CSS` 34 → 44 and `FLAG_H_CSS` 42 → 48 (a touch taller for the 2nd line); the two lines **auto-size down** (via `measureText` on the wider line, "Trips") so they can never overflow the pennant. The quad corner offsets and the CPU hit-test use `FLAG_LEFT_CSS`/`FLAG_RIGHT_CSS` so the pole-left shape stays tap-accurate.
- Label is defined once as `FLAG_LINES = ["45+","Trips"]`: the WebGL pennant draws the two lines, the disc+text fallback uses a two-line `text-field` (`"45+\nTrips"`), the DOM drag/preview marker is a compact two-line badge, and the color-picker dialog uses the joined `FLAG_TEXT` ("45+Trips").

### City Events on the map — concerts, sports, conventions (new feature)
- Added `city-events.feature.js`: a standalone, read-only map layer that reads `GET /city_events` (today's big NYC events, fetched from Ticketmaster by the backend) and drops a **category pin per event** — concert (♪, purple), sports (ball, orange), convention (badge, teal) — as canvas sprites via `map.addImage`. Self-contained, no clustering, registered in `index.html` after `major-buildings.feature.js`.
- **Let-out pulse = the best-pickup signal.** Each event runs `upcoming → in_progress → letting_out → ended`, derived on the client from `startAt` + a per-category duration estimate (concert/sports ~3h, convention ~5h; let-out window = end −15m to end +45m). **Only the events letting out right now pulse** — a gold ring at the venue (the same "best time, now" language as the dollar-flag prime pulse) — so a driver instantly sees which venue is about to release a surge of riders. Upcoming and mid-event venues are static icons. The pulse loop runs only while ≥1 event is letting out, ~30fps, paused when the tab is hidden.
- **Name labels** from z13, collision-managed (`text-allow-overlap: false` + padding) and category-colored with a white halo, so dense areas don't stack. Pins from z11.
- **Tap a pin** for a popup: category tag, event name, venue, a live status chip (**"Letting out — best pickup"** / "In progress · lets out ~10:30 PM" / "Starts in 45m"), the start–estimated-end time (NYC), and a **Tickets / info** link (`target=_blank rel=noopener`). A 1-minute tick re-evaluates every event's state so pins advance through the states and the pulse set updates live.
- Passive z-order keeper (only re-adds after a real style reload) so it never fights other layers — avoids the flashing class of bug fixed earlier. Dormant + harmless when the backend has no `TICKETMASTER_API_KEY` (empty list → no pins).

## 2026-06-08

### Major landmarks — type labels appear sooner
- The "HOSPITAL"/"HOTEL" tags now show from **z13** (was z15), so you see what a building is without zooming in as far. Still collision-managed (`text-allow-overlap: false`), so dense Midtown stays decluttered — they just start appearing earlier and where there's room. Text-size curve extended down to z13 (9.5px) so they're legible at the lower zoom.

### Major landmarks — non-Midtown icons 20% smaller
- Scaled the non-Midtown landmark `icon-size` to **80% (a uniform 20% smaller)** at every zoom, per request. Midtown sizing is unchanged. Non-Midtown stops are now `z11 0.40 / z14 0.59 / z16 0.74 / z18 0.90` (were `0.5 / 0.74 / 0.92 / 1.12`).

### Major landmarks — shrink ONLY Midtown at zoom-out (restore the rest)
- The previous declutter shrank every landmark, but only Midtown was actually crowded. Made the zoom-out size **data-driven**: only landmarks inside a Midtown box (Times Sq / 5th Ave / Central Park South — 14 of them, the dense hotel cluster + Mt Sinai West) are shrunk at zoom-out (`icon-size` z11→0.24), converging back to normal size by z18. The other **24** (UES medical row, downtown, outer boroughs) are **back to the original, larger size**. Also reverted `MIN_ZOOM` 12→11 so the non-Midtown ones show from the same zoom as before.

### Major landmarks — declutter at zoom-out
- The landmark icons + "HOSPITAL"/"HOTEL" tags crowded together at zoom-out (esp. Midtown). Cleaned it up: icons are **much smaller when zoomed out** (size curve z12→0.3 ramping to z18→1.05, vs the old flat-ish 0.5–1.12), they no longer show at the **city-overview** zoom (min zoom 11→12), and the **type tags only appear from z15 and are now collision-managed** (`text-allow-overlap: false` + padding) so they show only where there's room instead of stacking. Result: clean small markers when zoomed out, growing with the type label appearing as you zoom in.

### Flag buildings flashing fix + bigger/labeled landmark icons
- **Dollar-flag buildings flashing**: the flag system's *own* z-order keeper (`long-trip-hotspots-pins.feature.js`) also called `moveLayer` on every `styledata`. Even a no-op move-to-top fires another `styledata`, so it re-triggered itself every frame and continuously re-placed the symbol building layer — which reads as flashing. Added an **"already on top" guard**: it now skips the move when its layers are already the topmost in order, so it only acts after a real reload. Falls back to the old always-move behavior if the layer order can't be read (no regression).
- **Hospital/hotel icons were too skinny / hard to read**: redrew them as **bold, WIDE building blocks** (window grid + roof cap) with a **big central emblem** — red medical cross for hospitals, gold star for hotels — and bumped the icon size up ~45%. Added a **"HOSPITAL" / "HOTEL" type tag above each building** (colored by type, white halo) from z13, so it's instantly clear what each one is. The full name stays in the tap popup.

### Major landmarks — fix flashing icons + overlapping pin
- **Flashing fix**: the major-buildings z-order keeper called `moveLayer` on every `styledata` event. The flag system runs its own `styledata` keeper doing the same, and because `moveLayer` itself fires `styledata`, the two keepers re-triggered each other every frame and ping-ponged the layer order — making overlapping building icons flash. The keeper is now **passive**: it only re-adds + lifts its layers when a real style reload has dropped them, and never continuously lifts, so there's nothing to fight.
- **Overlap fix**: The Peninsula and The St. Regis sat ~20m apart (imprecise Peninsula coordinate), stacking their icons. Moved The Peninsula to its actual 700 5th Ave location (~110m away); the closest landmark pair is now 87m, so no icons overlap.

### Major landmarks — building icons redesigned + pulse de-cluttered
- Redrew the hospital & hotel sprites in `major-buildings.feature.js` to use the **approved skyscraper silhouette** (the same slim glass-tower design as the flag-system building sprite) so they read as real buildings, recolored + emblemed per type: **hospital** = cool white-blue glass tower with a red-cross badge; **hotel** = warm amber-gold glass tower with a crown star + entrance awning.
- **De-cluttered the pulses**: landmark pulse rings are now thinned in **screen space** (recomputed on move/zoom) so clustered buildings collapse to a few well-spaced rings, and they stay clear of the dollar-flag pulses (reads the flag positions via `window.LongTripHotspotsFeature.getHotspots()`). Icons are never thinned — only the rings — so every building still shows; the pulse set is dense at street level and sparse when zoomed out, fixing the "many pulses stacked on top of each other" look.

### Major hospital & hotel landmarks (new feature)
- Added `major-buildings.feature.js`: a standalone, read-only map layer showing **38 major NYC hospitals & hotels** as individual buildings with **distinct, identifiable icons** — hospitals as a white tower with a red medical cross, hotels as a gold tower with a star + entrance awning (canvas sprites via `map.addImage`). Separate from the dollar-flag system: no flags, no clustering, no backend.
- Each landmark **pulses** (a colored ring at its base) during its best-pickup window, researched from data: **hotels 7am–noon** (standard checkout 11am–noon → morning airport departures) and **hospitals noon–5pm** (≈55% of discharges are afternoon). Ring color is type-coded (hospital red, hotel gold); the loop runs only while ≥1 landmark is prime, ~30fps, paused when the tab is hidden.
- Icons appear from z11; **name labels** from z14; tap a building for a popup with its type, address, best pickup hours, and a live "Prime pickup now / Off-peak" chip. Coordinates reused from the hand-curated backend POI list. Registered in `index.html`'s feature-script list.

### Zone/hotspot transparency begins earlier
- Moved the start of the zoom-fade from **z14 to z12** for both the zones (`app.part12.js`) and the pickup-zone hotspots (`app.part10.js`), so the see-through transparency comes in earlier and users don't have to zoom in as far. Full transparency still lands at z16 (unchanged); only the begin breakpoint moved.
- Follow-up: nudged the begin one more level earlier, **z12 → z11**, for both layers (end still z16).

### Zoom-aware hotspot transparency
- Applied the same zoom-fade to the pickup-zone hotspot fills (`pickup-zone-hotspots-underpaint` + `-fill` in `app.part10.js`): their intensity-based opacity is preserved when zoomed out, then faded to **40% of it** as you zoom in close, so the **street layout underneath shows through** — matching the `zones-fill` behavior.
- Because these layers already drive `fill-opacity` off `intensity` (and `zoom` must stay at the top level of a paint expression), it's structured as a top-level zoom `interpolate` whose stop outputs are the intensity ramp (normal at z14) and that ramp × 0.4 (at z16). Applied on both the create and per-update repaint paths for `underpaint` and `fill`.
- The hotspot outline (`pickup-zone-hotspots-line`) stays as-is, so hotspot edges remain visible. Same z14/z16 breakpoints and 0.4 factor as the zones change (one-line tunables).

### Zoom-aware zone transparency
- The borough/score `zones-fill` layer now fades with zoom: solid color when zoomed out (so zones read clearly at borough/overview scale), ramping to **40% opacity (60% transparent)** as you zoom in close, so the **street layout underneath shows through** for navigation. Implemented as a `fill-opacity` zoom `interpolate` in `app.part12.js` (linear z14 → z16, held at 0.4 beyond), applied on both the layer create and the per-update repaint paths.
- The white zone outlines (`zones-line`) stay opaque, so zone boundaries remain crisp while the fill goes see-through.
- Compatible with the temporary paint overrides in `long-trips-block` (dim) and `navigation.streetmode` (route view): both cache/restore `fill-opacity` via get/setPaintProperty, so they preserve and restore the zoom expression. Breakpoints (14/16) and the 0.4 floor are one-line tunables.

## 2026-06-07

### Dollar-flag pickup-time correction + holiday/weekend calendar
- The map now consumes a backend **closure calendar** (federal holidays + NYC school recesses, served in the `/long_trip_hotspots` response) and matches its NYC date against it: weekday-only flags (offices, schools) go **dark and stop pulsing on weekends + holidays**, and the elite-school flag is dark all summer and over recesses. Hotels, transit, and hospitals keep running. Falls back to weekend-only behavior if the backend sends no calendar.
- Popup shows a **"Closed today (holiday)" / "Closed (school break)" / "Closed weekends"** chip when a flag is shut, taking precedence over the prime/peak/steady state.
- Picks up the backend's corrected pickup windows automatically (hotels = morning **checkout** only, not check-in; corporate = **end-of-day** only, not the morning arrival), since the schedule is server-driven.
- `nycHourAndDay()` now also returns the NYC `ymd`; new `closureReason()` gates `dimForHotspot`/`primeForHotspot` — weekend/holiday for weekday-only flags, plus explicit `[start,end]` ISO seasonal ranges (the backend's per-year school recesses) for the school flag; `sanitizeCalendar()` defensively parses the new field and degrades to weekend-only.

### Dollar-flag prime-time pulse
- Added a pulsing gold beacon at each dollar flag's pole base in `long-trip-hotspots-pins.feature.js`, shown only while that flag is in its **prime window** — the tightest "best time to be near it" hours for its building type (served by the backend in `dim_schedule.prime`, always a subset of `peak`). Prime windows in play: luxury hotels 7–11am (morning airport runs), transit hubs 7–9am & 5–8pm (rush + arrivals), hospitals 1–5pm (discharge peak), corporate 4–7pm and elite schools 2–4pm (weekdays only).
- Rendered as three map-anchored MapLibre circle layers — a steady soft glow plus two stroke-only "radar" rings that expand and fade out of phase. Map-anchored like the flags, so zero iOS-Safari drift; the rings scale with the flag's zoom curve and sit below the building/flag layers (a halo on the ground under the pole).
- The animation runs only while ≥1 flag is in prime (re-evaluated on the existing per-minute dim tick and 5-min refresh), is throttled to ~30fps, and pauses entirely while the tab is hidden.
- Popup now shows a **"Prime time now"** chip (with the same pulsing dot) that outranks the existing peak/steady/off state — plus the "Best hours" and "Why this is a hotspot" rows and the live time-of-day dim, all of which were previously blank/dormant because the backend never sent `dim_schedule`/`best_hours`/`rationale` (now fixed in the paired backend change).
- Degrades gracefully: if the backend doesn't send `dim_schedule.prime` (older deploy), no flag pulses and nothing else changes.

## 2026-03-19

### Phase 1 cleanup
- Kept the extracted shell CSS strategy in place: `index.html` now loads `frontend-shell.css` and `index.extracted.css` instead of carrying the old giant inline stylesheet.
- Kept non-core startup lean by loading only shared runtime/core app/chat/pickup/day-tendency scripts at first paint and leaving leaderboard/admin code behind `app.lazy.js`.
- Preserved dock/panel behavior while ensuring lazy leaderboard/admin loads only happen once.

### Presence/runtime updates
- Updated `app.js` presence transport to prefer `/presence/viewport` snapshots when bounds are available, then use `/presence/delta` incremental syncs when cursor/timestamp state exists, and finally fall back to `/presence/all` for compatibility.
- Normalized presence sync timestamps into milliseconds so delta cursors stay consistent even when backend payloads provide seconds, milliseconds, or ISO timestamps.
- Preserved the in-memory `presenceStore` / in-place marker update path so visible drivers stay responsive without rebuilding every marker on each poll.

### Safe Phase 2 chat/runtime status
- Retained the centralized public/private polling loops in `app.part2.js` with abortable fetches and single-timer scheduling.
- Kept the capability-gated SSE receive abstraction in place for public chat and DM summaries, with polling still active as the fallback/reconcile lane.
- Preserved existing unread, sound, kill-feed, and profile-DM behavior while documenting the live-delivery runtime and remaining background work.

### Documentation refreshed
- Rewrote `PERFORMANCE-ARCHITECTURE.md` to describe the actual startup order, dock flow, presence transport, pickup overlay flow, polling ownership, hidden work, and eager vs lazy modules.
- Rewrote `SAFE-PHASE2-CHAT-RUNTIME.md` to document the current polling/runtime behavior, unread storage, sound/feed paths, duplicate-risk points, and SSE fallback strategy.
- Rewrote `FRONTEND-REGRESSION-CHECKLIST.md` to match the requested product-surface checklist and the checks that were actually run in this environment.

## 2026-03-24

### Phase 3 shadow inspection (frontend only)
- Added `app.part14.js` to read Phase 2 citywide shadow earnings fields from zone feature properties with null-safe normalization and comparison helpers, without changing visible scoring or fill-color logic.
- Added popup/debug-facing shadow summary helpers so legacy vs shadow rating/bucket/confidence can be inspected when debug mode is enabled (or `window.__TEAM_JOSEO_SHADOW_PREVIEW__ === true`).
- Kept real-time presence and polling behavior unchanged; no new polling loops, network calls, or map layers were introduced.

### Phase 4 visible citywide cutover
- Switched visible citywide map scoring to Team Joseo shadow earnings-opportunity fields (`earnings_shadow_rating_citywide_v2` + shadow bucket/color when available), while keeping borough/special mode overrides limited to their own scopes.
- Updated popup main score and non-special recommendation wording to align with the new visible map score source.
- Updated mode/colors explanatory notes to clarify that out-of-scope zones still use the Team Joseo citywide score.
- Kept presence and polling behavior unchanged; no new polling loops or network calls were added.

### Phase 6 Bronx/Wash Heights visible cutover
- Updated Bronx/Wash Heights mode score-source selection in `app.part11.js` to prefer `earnings_shadow_*_bronx_wash_heights_v2` inside Bronx + corridor scope, with legacy `bwh_local_*` fallback only when BWH shadow is unavailable.
- Extended shadow readers/debug output in `app.part11.js` and `app.part14.js` to include Bronx/Wash Heights shadow fields (and readiness/comparison summary support) while keeping citywide and Manhattan shadow paths active in their existing scopes.
- Updated BWH popup extra line (`app.js`) and recommendation ranking/wording (`app.part9.js`) so Bronx/Wash Heights mode now reflects Bronx/Wash Heights earnings shadow rating when present.
- No presence or polling behavior changes were made.

### Phase 7 Queens visible cutover
- Updated Queens mode score-source selection in `app.part11.js` to prefer `earnings_shadow_*_queens_v2` inside Queens non-airport scope, with `qn_local_*` fallback only when Queens shadow fields are unavailable.
- Extended shadow readers/debug output in `app.part11.js` and `app.part14.js` to include Queens shadow fields and Queens shadow readiness/summary metadata while keeping citywide/Manhattan/BWH cutovers active in their existing scopes.
- Updated Queens popup extra line (`app.js`) and Queens recommendation ranking/wording (`app.part9.js`) so Queens mode now uses Team Joseo Queens earnings score when available.
- No presence or polling behavior changes were made.

### Phase 8 Brooklyn visible cutover
- Updated Brooklyn mode score-source selection in `app.part11.js` to prefer `earnings_shadow_*_brooklyn_v2` inside Brooklyn scope, with `bk_local_*` fallback only when Brooklyn shadow fields are unavailable.
- Extended shadow readers/debug output in `app.part11.js` and `app.part14.js` to include Brooklyn shadow fields and Brooklyn shadow readiness/summary metadata while keeping citywide/Manhattan/BWH/Queens cutovers active in their existing scopes.
- Updated Brooklyn popup extra line (`app.js`) and Brooklyn recommendation ranking/wording (`app.part9.js`) so Brooklyn mode now uses Team Joseo Brooklyn earnings score when available.
- No presence or polling behavior changes were made.

### Phase 9 Staten Island visible cutover
- Updated Staten Island mode score-source selection in `app.part11.js` to prefer `earnings_shadow_*_staten_island_v2` inside Staten Island scope, with `si_local_*` fallback only when Staten Island shadow fields are unavailable.
- Extended shadow readers/debug output in `app.part11.js` and `app.part14.js` to include Staten Island shadow fields and Staten Island shadow readiness/summary metadata while keeping citywide/Manhattan/BWH/Queens/Brooklyn cutovers active in their existing scopes.
- Updated Staten Island popup extra line (`app.js`) and Staten Island recommendation ranking/wording (`app.part9.js`) so Staten Island mode now uses Team Joseo Staten Island earnings score when available.
- No presence or polling behavior changes were made.

### Phase 10 community crowding caution layer
- Added a separate Team Joseo community crowding caution layer driven by existing live Team Joseo presence snapshots; this is community-only signal and not TLC/HVFHV truth.
- Added one lightweight dashed amber/orange caution outline plus popup/recommendation caution messaging, while keeping base zone colors unchanged.
- Kept presence/polling timing unchanged with no new polling loops or network requests.


### Phase 11 semantic + validation cleanup
- Standardized user-facing language around “Team Joseo score” / “earnings score” across mode notes, popup score labels/source labels, recommendation text, and colors-panel meaning text.
- Added a lightweight unified zone audit helper (`app.part16.js`) that reports visible source/label, mode tag, shadow snapshots, and community caution snapshot for any zone without adding polling/network work.
- Added a lightweight recommendation audit helper (`window.getTeamJoseoRecommendationAudit`) to expose the latest selected recommendation summary.
- No visible score logic, borough formulas, community-crowding logic, polling cadence, or presence timing behavior changed in this phase.

### Phase 12 final production hardening / cleanup
- Finalized visible score semantics so user-facing labels consistently show Team Joseo score wording without exposing legacy/shadow terminology in normal popup/recommendation/community caution copy.
- Added visible shadow readiness helpers and technical/fallback labeling hooks for debug/audit tooling while preserving the existing score-source precedence and score formulas.
- Added system-level audit summary helper (`window.getTeamJoseoSystemAudit`) that reports per-frame source counts, readiness, fallback usage, mode flags, recommendation audit, and community-crowding debug data on demand.
- All visible mode cutovers remain active; no score formulas, recommendation math, community crowding math, polling cadence, or presence timing were changed in this phase.

## 2026-03-25

### Phase 1 density + trip-quality shadow inspection (frontend only)
- Extended shadow-field ingestion/summaries so frontend debug/audit paths can inspect zone-area density metrics and long-trip/trap-related shadow fields, including normalized counterparts.
- Extended zone audit and shadow preview debug output to surface the new density/trip-quality values when present.
- Visible Team Joseo scores, recommendation logic, and normal map color behavior remain unchanged in this phase.

### Phase 2 citywide_v3 shadow inspection (frontend only)
- Extended frontend shadow ingestion/comparison helpers to read and compare citywide_v3 candidate fields (rating/bucket/confidence/positive/negative/score/color) strictly for debug/audit inspection.
- Extended zone audit and debug shadow preview output to include a compact Team Joseo citywide_v3 candidate subsection when citywide_v3 data is present.
- Visible Team Joseo scores, recommendation logic, and normal map color behavior remain unchanged in this phase.

### Phase 3 citywide_v3 visible cutover
- Switched the default (no-special-mode) visible citywide Team Joseo map score source to `citywide_v3` shadow fields, with retained `citywide_v2` shadow as fallback and debug comparison path.
- Kept all borough-mode visible profiles/precedence unchanged (Manhattan, Bronx/Wash Heights, Queens, Brooklyn, Staten Island continue to use their current v2 profile logic in-scope).
- Updated visible source labeling/readiness/debug wiring so audits can distinguish live `citywide_v3` vs `citywide_v2` fallback while still preserving both sets of citywide shadow comparison metrics.
- No presence logic, polling logic, polling intervals, or API routes were changed.

### Phase 4 borough_v3 shadow inspection (frontend only)
- Extended frontend shadow readers/comparison/summary paths to ingest borough-specific `*_v3` candidate fields strictly for debug/audit inspection.
- Extended zone audit + shadow preview debug output to expose borough_v3 candidate rating/bucket/confidence and delta-vs-v2 for the currently active special-mode borough only.
- Visible borough scores remain unchanged in this phase, and `citywide_v3` remains the live citywide score.

### Phase 5 Manhattan_v3 visible cutover
- Switched Manhattan-mode visible Team Joseo score source to `manhattan_v3` shadow fields for in-scope Manhattan zones, with `manhattan_v2` shadow retained as fallback/debug comparison.
- Kept `citywide_v3` as the live citywide visible score and left Bronx/Wash Heights, Queens, Brooklyn, and Staten Island visible profile behavior unchanged in this phase.
- Updated Manhattan popup/recommendation/debug/audit wiring to prefer `manhattan_v3` while preserving `manhattan_v2` comparison visibility.
- No presence logic or polling behavior/interval changes were made.

### Phase 6 Bronx/Wash Heights_v3 visible cutover
- Switched Bronx/Wash Heights-mode visible Team Joseo score source to `bronx_wash_heights_v3` shadow fields, with `bronx_wash_heights_v2` shadow retained as fallback and debug comparison.
- Kept `citywide_v3` live citywide behavior and `manhattan_v3` live Manhattan behavior unchanged, and left Queens/Brooklyn/Staten Island visible profile logic unchanged for this phase.
- Updated Bronx/Wash Heights popup/recommendation/debug/audit wiring to prefer v3 while preserving v2 fallback/comparison visibility.
- No presence logic or polling behavior/interval changes were made.

### Phase 7 Queens_v3 visible cutover
- Switched Queens-mode visible Team Joseo score source to `queens_v3` shadow fields for non-airport Queens zones, with `queens_v2` shadow retained as fallback and debug comparison.
- Kept `citywide_v3` live citywide behavior, `manhattan_v3` live Manhattan behavior, and `bronx_wash_heights_v3` live Bronx/Wash Heights behavior unchanged; Brooklyn/Staten Island visible profile logic also remains unchanged in this phase.
- Updated Queens popup/recommendation/debug/audit wiring to prefer v3 while preserving v2 fallback/comparison visibility.
- No presence logic or polling behavior/interval changes were made.

### Phase 8 Brooklyn_v3 visible cutover
- Switched Brooklyn-mode visible Team Joseo score source to `brooklyn_v3` shadow fields for Brooklyn zones, with `brooklyn_v2` shadow retained as fallback and debug comparison.
- Kept `citywide_v3` as the live citywide score, `manhattan_v3` as the live Manhattan score, `bronx_wash_heights_v3` as the live Bronx/Wash Heights score, and `queens_v3` as the live Queens score.
- Staten Island visible profile behavior remains unchanged in this phase (still on the current visible v2 profile logic).
- No presence or polling behavior/interval changes were made.

### Phase 9 Staten Island_v3 visible cutover
- Switched Staten Island-mode visible Team Joseo score source to `staten_island_v3` shadow fields for Staten Island zones, with `staten_island_v2` retained as fallback/debug comparison.
- Kept `citywide_v3` as the live citywide score and left `manhattan_v3`, `bronx_wash_heights_v3`, `queens_v3`, and `brooklyn_v3` live behavior unchanged.
- Visible v3 rollout is now complete across citywide and all borough modes.
- No presence logic or polling behavior/interval changes were made.
