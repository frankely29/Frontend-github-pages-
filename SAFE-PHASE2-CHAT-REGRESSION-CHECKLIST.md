# SAFE PHASE 2 Chat Regression Checklist

## Capability and fallback coverage
- [ ] Polling-only chat works when EventSource is unsupported.
- [ ] Polling-only chat works when `/chat/live/capabilities` is unavailable.
- [ ] SSE connects when `window.CHAT_LIVE_CONFIG` includes valid URLs.
- [ ] SSE connects when `/chat/live/capabilities` returns valid public/private URLs.
- [ ] Public and private transports can fall back independently without breaking the other side.

## Public chat
- [ ] Public chat send still uses the existing HTTP send path.
- [ ] Public chat receive works with polling only.
- [ ] Public chat receive works with SSE enabled.
- [ ] No duplicate public messages appear after live event + reconciliation poll overlap.
- [ ] No duplicate public unread increments occur.
- [ ] No duplicate public sound occurs.
- [ ] No duplicate kill feed entries occur.

## Private chat / DM summaries
- [ ] DM send still uses the existing HTTP send path.
- [ ] DM receive works with polling only.
- [ ] DM receive works with SSE enabled.
- [ ] Active DM thread only reconciles the active thread when needed.
- [ ] Hidden DM threads update summary/unread state without forcing full-history reloads.
- [ ] No duplicate DM messages appear after live event + poll overlap.
- [ ] No duplicate DM unread increments occur.
- [ ] No duplicate DM sound occurs.

## Transport safety
- [ ] Only one public EventSource exists at a time.
- [ ] Only one private EventSource exists at a time.
- [ ] Reconnect uses backoff and does not hot loop.
- [ ] Low-frequency reconciliation polling remains active while SSE is connected.
- [ ] Signing out tears down live transports cleanly.
- [ ] Signing back in can restore live transports safely.

## Non-chat regressions
- [ ] Map responsiveness is unchanged.
- [ ] Presence behavior is unchanged.
- [ ] Save/pickup behavior is unchanged.
- [ ] Leaderboard/profile/admin/games/radio/dock behavior is unchanged.
