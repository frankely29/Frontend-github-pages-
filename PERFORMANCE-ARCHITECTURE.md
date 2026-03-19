# Frontend Performance Architecture

## Actual startup script order
1. `index.html` loads MapLibre CSS and JS from `unpkg` in the document head.
2. `index.html` loads `frontend-shell.css`, `index.extracted.css`, and `admin.panel.css` as static stylesheets.
3. The body delivers the full shell markup up front: map canvas, auth overlay, side panels, dock, slider, weather badge, online badge, radio modal, and debug panel.
4. Inline config sets `window.API_BASE`.
5. `runtime.shared.js` loads first and registers shared helpers for URL resolution, auth-aware fetch wrappers, poll/timer dedupe, perf counters, and account actions.
6. `app.js` loads next and boots the map, timeline/frame system, auth shell, self-location watch, presence transport/render loop, pickup overlay, dock shell, weather badge, and top-level panel wiring.
7. `app.part2.js` loads after `app.js` and boots public chat, private messages, unread badges, kill feed, games, profile/driver messaging, chat sounds, and live-chat capability probing.
8. `pickup-recording.feature.js` and `day-tendency.js` load at startup because Save/pickup recording and the day tendency badge still participate in the initial shell.
9. `app.lazy.js` loads last and attaches deferred script-group loaders so leaderboard and admin code stay out of first paint.

## Actual panels and dock flow
- The dock buttons in `app.js` still own the shell-level open/close state for Colors, Modes, Chat, Games, Leaderboard, Admin, Music, and Profile.
- Drawer open/close state is centralized through the dock drawer markup (`#dockDrawer`, `#dockDrawerBody`, `#dockBackdrop`) and button state styling in `setActiveDockButton(...)` / `openDockPanel(...)` flows inside `app.js`.
- `app.part2.js` owns the chat drawer body population, tab switching, unread badge updates, kill feed state, games panel wiring, and profile/DM overlays.
- Leaderboard and admin buttons stay visible in the dock shell, but `app.lazy.js` intercepts their first click, loads the missing scripts once, and then hands control back to `window.LeaderboardPanel.open()` or `window.AdminPortal.open()`.
- Repeated opens do not inject duplicate script tags because `app.lazy.js` caches loaded groups in `loadedGroups` and marks each script node with `data-lazy-src`.

## Current presence fetch/render flow
### Transport selection
- `app.js` computes viewport-aware presence params in `getPresenceRequestParams()` using `min_lng`, `max_lng`, `min_lat`, `max_lat`, `zoom`, `mode`, `limit`, `viewport_sig`, and `refresh_tier`.
- `fetchPresencePayload(...)` now prefers a viewport snapshot route on full fetches:
  - `/presence/viewport?...` when bounds are available and the route has not been marked unsupported.
  - `/presence/all?...` as the compatibility fallback.
- Subsequent syncs try `/presence/delta?...` first when a cursor or sync timestamp is available.
- Delta sync uses `cursor` and `updated_since_ms` consistently, with timestamp normalization back into milliseconds.
- If `/presence/delta` or `/presence/viewport` returns 404/405/501 or an unsupported response shape, the frontend automatically falls back to the broader snapshot route instead of breaking the map.

### Merge/store behavior
- Presence rows are normalized in `normalizePresenceRow(...)` and stored in `presenceStore`, keyed by user id.
- `mergePresencePayload(...)` applies removals first, then upserts only valid/still-fresh rows.
- `cachedPresenceRows` is rebuilt from the in-memory store so stale rows naturally age out without forcing a full marker rebuild.
- The online badge is updated from payload summary counts when present, otherwise from `/presence/summary`, and finally from the visible row count as a last fallback.

### Rendering behavior
- `renderAdaptivePresenceFromCache()` filters the cached store to current render bounds, computes a render mode (`full` / `medium` / `lite`), and keeps richer DOM markers only for the chosen visible users.
- `upsertDriverMarker(...)` mutates existing markers in place for users that stay in the rich set.
- Lower-priority visible drivers are pushed into the `presence-lite` GeoJSON source instead of creating many rich DOM markers.
- Users removed from the rich set have their DOM markers cleaned up, but the underlying store entry remains available for future viewport re-entry until stale expiry/removal.

## Current pickup overlay fetch flow
- Startup keeps pickup support active because Save/pickup remains a top-level feature.
- `refreshPickupOverlay(...)` in `app.js` builds a buffered viewport query through `pickupOverlayQueryPath(...)` and requests `/events/pickups/recent` with viewport bounds, `limit`, and `zone_sample_limit`.
- Pickup fetches are guarded by:
  - `pickupOverlayAbortController` to cancel superseded requests,
  - `lastPickupFetchKey` + `lastPickupViewportKey` to avoid duplicate re-fetches,
  - `PICKUP_FETCH_COOLDOWN_MS` to suppress stormy redraws.
- Response application is serial-number guarded so older responses cannot overwrite newer viewport data.

## Current public chat polling flow
- `app.part2.js` owns public chat receive state.
- `scheduleChatPoll(...)` uses exactly one timeout loop for public chat and routes through `FrontendRuntime.polling` when available.
- Poll cadence is state-aware:
  - open/visible public chat uses the fast open cadence,
  - closed chat uses a slower badge-maintenance cadence,
  - hidden documents use the hidden cadence,
  - SSE-connected modes intentionally keep a slower fallback poll lane alive.
- `chatPollOnce()` prevents overlap with `chatPollInFlight`, cancels superseded HTTP work via `chatPollAbortController`, and uses incremental `after=` fetching once a baseline has been established.
- Hidden closed chat no longer keeps downloading the full visible history payload every cycle; it first seeds a tiny baseline and then polls incrementally from the latest known id.

## Current DM polling flow
- `schedulePrivatePoll(...)` owns the inbox/thread-summary loop and uses a single timeout at a time.
- Each cycle refreshes `/chat/private/threads` and, if a thread is active, incrementally fetches that thread instead of reloading every DM history.
- Per-thread DM fetches are guarded with `AbortController`s stored in `privateMessageAbortControllers`.
- Driver-profile DMs use a separate timeout lane that only runs while a non-self profile modal is open.

## Hidden panel work that still runs unnecessarily
- Public chat still keeps a reduced unread/notification poll alive while closed; this is intentional for badges, but it is still background work.
- Private thread summaries still refresh while the drawer is closed so unread counts stay current.
- Driver-profile DM polling continues while the profile modal is open, only slowing down when the document is hidden.
- Weather, self-location, presence, pickup, and day-tendency timers continue regardless of dock state because they power always-visible map UI.
- Progression/auth observer/identity cleanup loops from `app.part2.js` still exist, but they now run through stable timers rather than spawning recursive duplicates.

## Exact modules currently eagerly loaded
### CSS
- `https://unpkg.com/maplibre-gl@5.10.0/dist/maplibre-gl.css`
- `./frontend-shell.css`
- `./index.extracted.css`
- `./admin.panel.css`

### JavaScript
- `https://unpkg.com/maplibre-gl@5.10.0/dist/maplibre-gl.js`
- `./runtime.shared.js`
- `./app.js`
- `./app.part2.js`
- `./pickup-recording.feature.js`
- `./day-tendency.js`
- `./app.lazy.js`

## Exact modules currently lazy-loaded on demand
### Leaderboard group
- `./app.part3.js`

### Admin group
- `./admin.components.js`
- `./admin.actions.js`
- `./admin.users.js`
- `./admin.live.js`
- `./admin.reports.js`
- `./admin.system.js`
- `./admin.trips.js`
- `./admin.tests.js`
- `./admin.panel.js`
