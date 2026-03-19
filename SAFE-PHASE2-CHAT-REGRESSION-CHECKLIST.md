# SAFE PHASE 2 Chat Regression Checklist

Use this checklist after deployment/testing.

## Auth lifecycle
- [ ] Sign in works.
- [ ] Sign out works.
- [ ] Chat polling resumes after sign in.
- [ ] Chat live transport tears down on sign out.
- [ ] Chat live transport can reconnect after sign back in.

## Public chat
- [ ] Public chat send still uses the existing HTTP send path.
- [ ] Public chat receive works with polling only.
- [ ] Public chat receive works with SSE enabled, if backend support exists.
- [ ] Public chat unread increments while chat is closed.
- [ ] Opening public chat clears public unread appropriately.
- [ ] Public unread does not resurrect after refresh.
- [ ] No duplicate public messages after refresh/reconnect.
- [ ] No duplicate public notification sound.
- [ ] No duplicate kill feed items.
- [ ] Kill feed still updates quickly for new public chat events.

## Private messages / inbox
- [ ] DM send still uses the existing HTTP send path.
- [ ] DM receive works with polling only.
- [ ] DM receive works with SSE enabled, if backend support exists.
- [ ] Hidden inbox/thread list unread stays accurate.
- [ ] Opening one DM thread clears only that thread’s unread.
- [ ] DM unread does not resurrect after refresh.
- [ ] No duplicate DM messages after refresh/reconnect.
- [ ] No duplicate DM notification sound.
- [ ] Active thread only does incremental fetch when needed.
- [ ] Hidden threads do not trigger full-history downloads on each live event.

## Driver-profile DM modal
- [ ] Driver-profile DM send still works.
- [ ] Driver-profile DM receive still works.
- [ ] Opening/closing the driver profile does not leak polling/live listeners.

## Performance / safety
- [ ] Map responsiveness is unchanged.
- [ ] Presence behavior is unchanged.
- [ ] Save/pickup behavior is unchanged.
- [ ] Leaderboard/profile/admin/games/radio/dock behavior is unchanged.
- [ ] Public and private polling still function if SSE is unavailable.
- [ ] EventSource reconnect uses backoff and does not hot loop.
- [ ] Only one public EventSource connection exists at a time.
- [ ] Only one private/DM EventSource connection exists at a time.
