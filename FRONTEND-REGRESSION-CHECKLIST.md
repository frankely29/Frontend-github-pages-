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
