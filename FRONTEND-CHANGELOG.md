# Frontend Changelog

## 2026-06-08

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
