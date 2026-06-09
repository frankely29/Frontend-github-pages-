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

## Dollar-flag label "45+" → two lines "45+ / Trips" (narrow)
- [x] `node --check long-trips-block.feature.js` passes; no leftover `halfW` references
- [x] `FLAG_LINES = ["45+","Trips"]` is the single source: WebGL pennant draws two lines, the disc+text fallback uses `"45+\nTrips"`, the DOM marker is a two-line badge, the picker dialog uses joined `FLAG_TEXT`
- [x] geometry verified by rendered preview: "45+" over "Trips" fits on green/sky/yellow, swallowtail notch intact, narrower than the one-line banner (`FLAG_W_CSS` 72 → 44); pole-base maps to quad dx=0 (`FLAG_LEFT_CSS + POLE_FRAC*FLAG_W_CSS == 0`)
- [x] both lines auto-size down via `measureText` on the wider line ("Trips") so they can't overflow the pennant
- [x] size restored to the ORIGINAL footprint (`FLAG_W_CSS` 44 → 34, `FLAG_H_CSS` 48 → 42) so the rename doesn't change on-map size
- [x] `flagZoomScale` zoom-out end lowered so flags shrink harder when far out: z≤9 `0.60 → 0.30`, z13 `0.85 → 0.65`, cap `1.10 → 1.05`; verified by a before/after rendered preview (far-out ≈ half size, zoomed-in ≈ unchanged)
- [ ] live map: zoomed out, flags are small/clean and clearly smaller than before; they grow to full size as you zoom in — no oversized/cluttered look at overview zooms
- [ ] live map: placed flags show "45+" over "Trips" on a narrow flag; the pole still pins to the exact tapped point
- [ ] live map: tapping the flag still selects it (hit-test matches the pole-left shape); long-press still opens Edit; drag/preview marker shows the two-line badge
- [ ] live map: three flags side-by-side don't bleed into each other (pennant stays inside its atlas slice)

## Zone zoom transparency
- [x] `node --check app.part12.js` passes; `zones-fill` opacity is a zoom `interpolate` on both the create and update paths
- [ ] live map: zones show normal solid color when zoomed out (≤ z14)
- [ ] live map: zooming in close (≥ z16) makes zones ~60% transparent and the street layout shows through
- [ ] live map: zone outlines stay crisp; long-trips-block dim and navigation street mode still restore opacity correctly afterward

## Hotspot zoom transparency
- [x] `node --check app.part10.js` passes; `pickup-zone-hotspots-underpaint`/`-fill` opacity is a top-level zoom `interpolate` over the intensity ramp, on both create and update paths
- [ ] live map: hotspots keep their intensity-based opacity when zoomed out (≤ z14)
- [ ] live map: zooming in close (≥ z16) fades hotspots ~60% and the street layout shows through; relative intensity differences still read
- [ ] live map: hotspot outlines remain visible; long-trips-block dim still restores hotspot opacity afterward

## Major hospital & hotel landmarks
- [x] `node --check major-buildings.feature.js` passes; registered in `index.html` feature list
- [x] mock-DOM smoke test: 2 sprites registered, 5 layers created, 38 landmark features; at 1pm NYC exactly the 19 hospitals enter the pulse source (afternoon discharge), hotels don't; rings animate; no `[mbf]` errors
- [ ] live map: hospital (red cross) and hotel (gold star) icons render distinctly from z11; names from z14
- [ ] live map: hospitals pulse afternoon (noon–5pm), hotels pulse morning (7am–noon)
- [ ] live map: tapping a building opens the popup (type, address, best hours, prime/off chip); no clash with zone/flag popups
- [x] icons redrawn as the approved skyscraper silhouette (hospital = white-blue + red-cross badge; hotel = amber-gold + crown star + awning); smoke test still passes
- [x] pulse rings thinned in screen space + kept clear of dollar-flag pulses; smoke test shows 19 prime hospitals → 16 after thinning at the test scale, re-thinned on `moveend`
- [ ] live map: clustered landmark pulses no longer pile up; thin out when zoomed out, separate when zoomed in; no overlap with flag pulses
- [ ] live map: hospital/hotel icons look like proper buildings (skyscraper style) and are still distinguishable at a glance
- [x] z-order keeper made passive (re-add on reload only, no per-`styledata` `moveLayer`) so it can't ping-pong with the flag keeper; no near-duplicate coords (closest pair 87m); `node --check` + smoke pass
- [ ] live map: building icons no longer flash; The Peninsula and St. Regis no longer overlap
- [x] flag z-order keeper guarded with an "already on top" check (skips no-op `moveLayer`s that re-fire `styledata`); both features `node --check` + smoke pass
- [x] hospital/hotel sprites redrawn as wide building blocks with a big emblem; icon-size bumped; "HOSPITAL"/"HOTEL" type tag added above each icon from z13
- [ ] live map: dollar-flag buildings no longer flash/blink
- [ ] live map: hospital/hotel icons are clearly bigger/wider and each shows "HOSPITAL"/"HOTEL" on top; type is obvious at a glance
- [x] declutter: smaller icon-size curve (z12→0.3), landmarks hidden below z12, type tags from z15 with `text-allow-overlap:false` + padding; `node --check` + smoke pass
- [ ] live map: zoomed out is clean (small markers, no label pile-up); icons grow and "HOSPITAL"/"HOTEL" tags appear (decluttered) as you zoom in
- [x] zoom-out size is now Midtown-only (data-driven `midtown` flag): box catches the 14 Midtown landmarks; UES medical/downtown/boroughs (24) keep original size; `MIN_ZOOM` back to 11; `node --check` + smoke pass
- [ ] live map: Midtown no longer blobs at a distance; non-Midtown buildings are back to their pre-#1015 size

## City events on the map (Ticketmaster)
- [x] `node --check city-events.feature.js` passes; registered in `index.html` after `major-buildings.feature.js`
- [x] mock-DOM smoke test (`/tmp/cbe_smoke.js`): 4 crafted events → states `letting_out` / `in_progress` / `upcoming` / `ended`; 3 category sprites registered, 5 layers created; geojson drops the ended event (3 features) and exactly **1** has `letout=true`; pulse rings animate; tapping the let-out pin shows the "best pickup" chip + a Tickets link; 0 `[cbe]` warnings
- [x] only `letting_out` events pulse (the let-out surge); upcoming/in-progress venues are static icons — the pulse source is exactly the let-out set
- [x] dormant when the backend returns `[]` (no `TICKETMASTER_API_KEY`): no pins, no errors
- [ ] live map: concert/sports/convention pins render distinctly from z11; names from z13 (collision-managed)
- [ ] live map: a venue letting out **now** pulses gold; the pulse moves to the next venue as events advance (1-min tick); upcoming/mid-event venues don't pulse
- [ ] live map: tapping a pin opens the popup (category, name, venue, live status chip, start–end NYC time, Tickets link); no clash with zone/flag/landmark popups

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

## Nightlife & dining districts
- [ ] Magenta cocktail-glass pins appear at the districts (from `GET /nightlife_districts`), visually distinct from the gold dollar-flag pins.
- [ ] During a district's let-out window the pin pulses magenta; outside it the pin dims and does not pulse (verify the weeknight `prime` vs Fri/Sat `prime_weekend` switch).
- [ ] Tapping a pin shows the venue list, a "best pickup" state chip, and best-hours; tapping empty map closes it.
- [ ] District labels appear at zoom >= 13 and the layer survives a base-style reload.
