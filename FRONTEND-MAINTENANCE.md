# Frontend Maintenance Note

## Runtime ownership
- `index.html`: application shell markup, debug panel, dock/drawer/modal containers, static script/style loading order.
- `frontend-shell.css`: extracted shell styling previously embedded in `index.html`.
- `runtime.shared.js`: shared API-base resolution, auth request helpers, account action helpers, named poll timer coordination, and lightweight perf counters.
- `app.js`: map bootstrap, timeline/frame loading, borough modes, weather, navigation/recommendation logic, auth shell, presence, pickup overlay, and top-level runtime orchestration.
- `app.part2.js`: chat, DMs, unread counts, kill feed, voice notes, profile UI, map identity UI, radio launcher wiring, progression hooks, and games.
- `app.part3.js`: leaderboard panel rendering and rank/badge views.
- `pickup-recording.feature.js`: pickup save flow and pickup-specific notices/reward hooks.
- `day-tendency.js`: tendency meter placement, polling, and GPS-triggered refresh behavior.
- `admin.*.js` + `admin.panel.css`: admin launcher/panel, tab content rendering, and admin visuals.

## Intentionally shared globals
- `window.API_BASE`: deployment override for backend origin; still honored first.
- `window.FrontendRuntime`: shared helper surface introduced for low-risk deduplication.
- `window.__mapPerfDebug`: lightweight production-safe perf/debug store used by app/chat instrumentation.
- Existing globals exported by `app.js` / `app.part2.js` remain in place for backwards compatibility.

## Module dependencies
- `app.js` remains the main owner of auth state and exports helpers consumed elsewhere.
- `app.part2.js` depends on `app.js` auth helpers plus shared polling/runtime helpers.
- `app.part3.js`, `pickup-recording.feature.js`, `day-tendency.js`, and `admin.panel.js` now prefer `window.FrontendRuntime` for API access.

## Polling locations
- `app.js`: named timers for frame refresh, NYC clock advancement, presence polling, and pickup overlay refresh.
- `app.part2.js`: named timers for public chat and private thread polling.
- `day-tendency.js`: named timers for retry, first GPS fix, position maintenance, movement checks, and scheduled refreshes.

## Auth/account flow location
- Primary auth state still lives in `app.js`.
- Canonical sign-out/change-password/delete-account request flow now routes through `runtime.shared.js` account helpers and is invoked from `app.js` UI handlers.
