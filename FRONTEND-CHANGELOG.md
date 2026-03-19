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
