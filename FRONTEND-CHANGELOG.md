# Frontend Changelog

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
