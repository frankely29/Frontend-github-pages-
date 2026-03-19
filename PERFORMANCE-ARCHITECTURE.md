# Frontend Performance Architecture

## Runtime shell and lazy-load boundaries
1. `index.html` eagerly loads `runtime.shared.js`, `app.js`, `app.part2.js`, `pickup-recording.feature.js`, `day-tendency.js`, and `app.lazy.js`.
2. `app.part3.js` remains lazy-loaded through `window.loadFrontendModuleGroup('leaderboard')`; it is **not** reintroduced into the shell.
3. The admin bundle remains lazy-loaded through the existing admin script group in `app.lazy.js`.
4. `app.js` now exports the drawer helpers on `window` (`openDrawer`, `closeDrawer`, `toggleDrawer`, `bindDockToggle`, `getOpenPanelKey`) so lazy modules can open drawers without depending on brittle implicit globals.

## Leaderboard loading contract
- The primary leaderboard open path now lives in `app.js`.
- `#dockLeaderboard` has its own explicit `pointerdown` and `click` handlers, matching the dock-admin pattern.
- `ensureLeaderboardPanelReady()` in `app.js` does the only required readiness check:
  - return immediately when `window.LeaderboardPanel.open` already exists,
  - otherwise lazy-load the `leaderboard` module group,
  - validate `window.LeaderboardPanel.open` after loading,
  - warn and record diagnostics if the panel still is not ready.
- `app.lazy.js` no longer owns leaderboard open behavior on click; it only keeps lazy loading support and optional preload hooks.
- `app.part3.js` exposes `window.LeaderboardPanel = { init, open, refresh }` and its `open()` path directly calls `window.openDrawer(...)`.

## Leaderboard bug root cause and fix
### Root cause
- The leaderboard dock button depended on a first-click interception path in `app.lazy.js`.
- That interception tried to lazy-load `app.part3.js`, while `app.part3.js` separately expected drawer helpers/global names to already exist and, during `init()`, tried to bind the same dock button again.
- This created a fragile race between shell click capture, module load timing, and later dock binding, so the first click could be consumed without deterministically opening the drawer.

### Fix
- `app.js` now owns the authoritative dock-button click path.
- `app.lazy.js` only preloads the leaderboard group and keeps `loadFrontendModuleGroup(...)` as the loader API.
- `app.part3.js` opens the drawer directly through exported helper functions and no longer depends on binding the leaderboard dock button to function.
- `window.__mapPerfDebug.leaderboard` now records `loaded`, `opened`, `lastError`, `lastOpenAt`, and `loadAttempts` for future troubleshooting.

## Presence transport architecture (Phase 1)
### Snapshot vs delta
- First presence load now prefers `/presence/viewport` whenever viewport bounds are available.
- Incremental refreshes prefer `/presence/delta`.
- `/presence/all` remains the compatibility fallback.

### Request contract
- Presence requests keep viewport params (`min_lat`, `min_lng`, `max_lat`, `max_lng`, `zoom`) when bounds are known.
- Presence requests now always include `include_removed=true` and `padding_ratio=<buffer ratio>`.
- Delta requests now send **only** the backend-aligned incremental cursor contract: `updated_since_ms=<ms cursor>`.
- The frontend no longer sends the unsupported `cursor` delta param as the main incremental contract.

### Cursor tracking
- `presenceLastSyncCursor` is now normalized to a millisecond cursor.
- The frontend normalizes backend cursor/timestamp variants into one millisecond value and reuses that value for both delta fetches and local sync state.

### Merge/render safety
- Presence payloads still merge into `presenceStore` instead of forcing a full marker rebuild.
- Removals are still applied first.
- Rich markers are still updated in place, while lighter nearby users continue to render through the `presence-lite` source.
- Full snapshot responses now explicitly replace the store, which avoids stale-user accumulation during fallback snapshots.

## Safe Phase 2 chat architecture
### Capability discovery
- `app.part2.js` still prefers `window.CHAT_LIVE_CONFIG` and otherwise probes `GET /chat/live/capabilities`.
- Missing/disabled capability payloads cleanly keep the app in polling mode.

### Capability normalization
- Capability normalization now tolerates more payload shapes for public/private SSE URLs while still refusing to enable SSE without a concrete URL.
- Public and private capability states are normalized independently, so one can stay on polling while the other uses SSE.

### Live transport safety
- At most one public EventSource and one private EventSource are maintained.
- Reconnect still uses exponential backoff.
- Low-frequency reconciliation polling remains active even while SSE is connected.
- Live events continue to merge into existing deduped chat state without forcing full-history reloads.

## Responsiveness guardrails kept in this pass
- No eager reintroduction of `app.part3.js` or admin bundles.
- No full-app rerender path added.
- No chat work added to map move handlers.
- No change to message send routes.
- No removal of polling fallback.
- Presence rendering still updates incrementally and preserves viewport responsiveness.
