# Optimization Changelog

## Timers changed
- Presence immediate refreshes now gate on a rounded viewport signature before forcing a zero-delay poll.
- Public chat hidden-mode polling now starts with a lightweight baseline instead of a full-history bootstrap.
- Progression sync now skips hidden-document work and uses the shared poll registry when available.
- Chat auth observation and identity cleanup moved from chained recursive `setTimeout` loops to stable intervals.

## Lazy-loaded now
- Leaderboard module (`app.part3.js`).
- Full admin bundle (`admin.components.js`, `admin.actions.js`, `admin.users.js`, `admin.live.js`, `admin.reports.js`, `admin.system.js`, `admin.trips.js`, `admin.tests.js`, `admin.panel.js`).

## Hidden-panel work reduced
- Hidden public chat avoids repeated full room bootstrap fetches.
- Hidden public chat keeps unread/kill-feed behavior through incremental fetches from the latest known message ID.
- Hidden progression sync work is skipped while the document is backgrounded.

## Presence / client merge logic added
- Added `presenceStore` client cache keyed by user ID.
- Added `presenceLastSyncTimestamp` / `presenceLastSyncCursor` tracking.
- Added optional `/presence/delta` fetch support with automatic fallback to `/presence/all`.
- Added explicit removal merge handling when backend delta payloads provide removed IDs.
- Added viewport signature metadata so presence fetches can react to meaningful bounds changes without spamming immediate refreshes.

## Remaining fallbacks
- `/presence/all` remains the default-compatible path when `/presence/delta` is unavailable.
- Chat send routes remain unchanged and still use HTTP polling receive paths.
- Games/profile/radio logic remain functionally unchanged and continue to use their existing code paths.
