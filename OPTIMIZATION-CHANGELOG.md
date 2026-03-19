# Optimization Changelog

## Leaderboard reliability
- Added `ensureLeaderboardPanelReady()` in `app.js` so the leaderboard dock button now owns a deterministic async readiness check.
- Moved leaderboard opening responsibility out of `app.lazy.js` click interception and into the explicit dock click handler in `app.js`.
- Kept lazy loading, but converted leaderboard lazy logic into loader/preload support instead of click takeover.
- Hardened `app.part3.js` so `LeaderboardPanel.open()` directly opens the drawer and works even if no dock rebinding occurs.
- Added lightweight leaderboard diagnostics in `window.__mapPerfDebug.leaderboard`.

## Presence contract alignment
- Switched delta requests to the backend-safe `updated_since_ms` contract.
- Normalized presence sync tracking to a millisecond cursor.
- Made `/presence/viewport` the preferred snapshot route when bounds are available.
- Kept `/presence/all` as fallback only.
- Marked full snapshot responses as replace-all merges so fallback snapshots do not leave stale rows behind.

## Safe Phase 2 chat hardening
- Strengthened live capability normalization for public/private SSE URLs.
- Kept polling fallback intact when capability discovery is unavailable, disabled, or partial.
- Preserved one-public / one-private EventSource limits and the existing reconnect + reconcile behavior.

## Lazy-loading boundaries preserved
- `app.part3.js` remains lazy-loaded.
- Admin scripts remain lazy-loaded.
- The shell script order remains unchanged aside from the new runtime contracts between `app.js`, `app.lazy.js`, and `app.part3.js`.
