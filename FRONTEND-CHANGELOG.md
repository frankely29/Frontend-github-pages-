# Frontend Changelog

## 2026-03-19

### What changed
- Added `runtime.shared.js` as a conservative shared frontend runtime for API-base resolution, auth-aware JSON helpers, detailed request parsing, account actions, poll timer coordination, and lightweight perf counters.
- Extracted the large `index.html` inline stylesheet into `frontend-shell.css` and loaded it as a versioned static asset without changing the existing markup structure.
- Updated `app.js` to reuse the shared runtime helpers, centralize sign-out/change-password/delete-account flows, coordinate core pollers, and expose lightweight debug timings for map, timeline, frame, presence, pickup overlay, blank-map warnings, and duplicate-poller guards.
- Updated `app.part2.js` to coordinate public/private chat poll timers through the shared poll registry and track chat polling errors.
- Updated `app.part3.js`, `pickup-recording.feature.js`, `day-tendency.js`, and `admin.panel.js` to consume the shared runtime API/request helpers instead of maintaining separate API-base/fetch logic.
- Kept `server.js` cache behavior aligned with the current deployment model while ensuring HTML shell requests remain `no-store`.

### Scope notes
- No endpoints, payload shapes, major UI contracts, or feature ownership were intentionally changed.
- Changes were limited to deduplication, polling coordination, CSS extraction, and lightweight instrumentation.
