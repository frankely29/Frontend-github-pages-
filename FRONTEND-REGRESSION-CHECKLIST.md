# Frontend Regression Checklist

## Core auth and shell
- [ ] Sign in works.
- [ ] Sign out works.
- [ ] Auth overlay still opens/closes and reflects signed-in state.
- [ ] Map loads.
- [ ] Timeline loads.
- [ ] Frame switching works.
- [ ] Dock opens/closes panels correctly.
- [ ] No duplicate script loads after repeated Leaderboard/Admin opens.

## Map/community/runtime behavior
- [ ] Borough modes still work.
- [ ] Ghost mode still works.
- [ ] Self location updates still work.
- [ ] Nearby visible drivers still feel responsive.
- [ ] Online badge still works.
- [ ] Police report still works.
- [ ] Save/pickup still works.
- [ ] Pickup overlay still works.
- [ ] No map performance regression during pan/zoom.

## Chat and messaging
- [ ] Public chat send still works.
- [ ] Public chat receive via polling still works.
- [ ] DM send still works.
- [ ] DM receive via polling still works.
- [ ] Unread badge still works.
- [ ] Sound still works.
- [ ] No duplicate timers after opening/closing chat repeatedly.

## Additional panels/features
- [ ] Profile still works.
- [ ] Leaderboard lazy-loads once and opens correctly.
- [ ] Admin lazy-loads once and opens correctly.
- [ ] Games still work.
- [ ] Radio still works.

## Dollar-flag prime-time pulse
- [x] `node --check long-trip-hotspots-pins.feature.js` passes
- [x] mock-DOM smoke test: only prime flags enter the pulse source; glow + 2 rings are created below the buildings/flag layers; rings animate out of phase; no `[lth]` errors
- [x] frontend prime predicate matches the backend (Sun 19:00 → 8 transit flags pulse; weekend drops weekday-only corporate/school)
- [ ] live map: gold ring visibly pulses at a flag's pole base during its prime window, and is absent outside it
- [ ] live map: popup shows the "Prime time now" chip plus the Best hours / Why rows during prime
- [ ] live map: no pan/zoom performance regression while a pulse is active

## Dollar-flag holiday/weekend calendar
- [x] `node --check long-trip-hotspots-pins.feature.js` passes
- [x] mock-DOM smoke test: with today marked a holiday + school in summer, only the open hotel flag pulses; corporate (holiday) and school (seasonal) are excluded; no `[lth]` errors
- [x] empty/absent calendar degrades to weekend-only behavior (`sanitizeCalendar` drops malformed input)
- [ ] live map: an office/school flag is dark with a "Closed (holiday)" chip on a federal holiday; the school flag is dark over summer
- [ ] live map: hotels/transit/hospitals still behave normally on holidays/weekends

## Checks completed in this environment
- [x] `node --check app.js`
- [x] `node --check app.part2.js`
- [x] `node --check runtime.shared.js`
- [x] `node --check app.lazy.js`
- [x] `node --check app.part3.js`
- [x] `node --check admin.panel.js`
- [x] `index.html` script order keeps shared runtime before core app scripts and removes eager admin loads.
- [x] Presence transport now prefers `/presence/viewport`, then `/presence/delta`, then `/presence/all` fallback without removing polling compatibility.

## Not fully verifiable in this headless environment
- [ ] Full browser-backed UX verification for sign-in, live map interactions, chat/audio, radio playback, games, and admin screens.
- [ ] Screenshot capture (browser screenshot tool unavailable in this session).

## Team Joseo Map battle/progression expansion regression additions
- [ ] Chess still works.
- [ ] UNO still works.
- [ ] Leaderboard still opens.
- [ ] Profile still opens.
- [ ] Pickup save still shows reward overlay.
- [ ] Level-up overlay still works.
- [ ] 1000-level ladder renders.
- [ ] Challenge create / accept / decline / cancel works.
- [ ] Dominoes battle completes and awards XP.
- [ ] Billiards battle completes and awards XP.
- [ ] Public winner banner appears.
- [ ] Profile shows win/loss stats.
