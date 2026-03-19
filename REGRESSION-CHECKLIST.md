# Regression Checklist

## Leaderboard
- [ ] Clicking the leaderboard dock icon opens the drawer on the first click.
- [ ] Clicking the leaderboard icon again toggles the drawer correctly.
- [ ] Signed-out users still see the leaderboard drawer with the sign-in prompt/status.
- [ ] Signed-in users still see leaderboard content.
- [ ] Leaderboard tabs/filters still switch correctly.
- [ ] Leaderboard drawer can reopen after close.

## Phase 1 presence
- [ ] First presence load uses the viewport snapshot path.
- [ ] Subsequent presence refreshes use the delta path with `updated_since_ms`.
- [ ] Removed users disappear correctly.
- [ ] Online summary badge remains correct.
- [ ] Nearby visible drivers remain responsive.
- [ ] Presence polling does not rebuild all markers unnecessarily on every poll.

## Safe Phase 2 chat
- [ ] App still works fully if SSE is unavailable.
- [ ] App still works fully if the capability route is unavailable.
- [ ] App uses SSE when a valid capability payload is present.
- [ ] No duplicate public messages appear.
- [ ] No duplicate DM messages appear.
- [ ] No duplicate unread increments appear.
- [ ] No duplicate sound plays.
- [ ] No duplicate kill feed entries appear.
- [ ] Reconnect fallback returns safely to polling.

## General frontend behavior
- [ ] Sign in / sign out still works.
- [ ] Map loads and zone frame rendering still works.
- [ ] Hotspot timeline still loads.
- [ ] Save / pickup recording still works.
- [ ] Self arrow stays truthful to real location and heading.
- [ ] Nearby visible drivers stay responsive.
- [ ] Ghost mode still behaves correctly.
- [ ] Public chat send / receive still works.
- [ ] DM send / receive still works.
- [ ] Unread badges still work.
- [ ] Kill feed still works.
- [ ] Admin still lazy-loads and opens correctly for admins.
- [ ] Profile sheet still opens correctly.
- [ ] Games still open correctly.
- [ ] Radio still opens correctly.
- [ ] Dock still behaves correctly.
