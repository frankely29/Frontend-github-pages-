# SAFE PHASE 2 Chat Changelog

## What live receive abstraction was added
- Added an optional chat live-transport layer in `app.part2.js` that can maintain:
  - one public chat EventSource connection max
  - one private/DM summary EventSource connection max
- The live layer is capability-driven:
  - uses `window.CHAT_LIVE_CONFIG` if present, or
  - probes `/chat/live/capabilities` when signed in
- The live layer is additive only. Existing HTTP send paths stay unchanged.

## Which parts still use polling
- Public chat still polls at all times.
- Private thread list still polls at all times.
- Active private thread still polls incrementally at all times.
- Driver-profile DM polling still exists.
- Polling remains the required fallback when:
  - SSE is unsupported
  - capability detection returns no URL
  - EventSource fails to connect
  - EventSource disconnects later
  - backend is partially upgraded

## Which parts use SSE if available
- Public chat:
  - receives live message payloads or nudges
  - merges new public messages into existing chat state
  - updates kill feed/unread/sound through the same deduped state
  - triggers lightweight reconciliation polling when the event payload is only a nudge
- Private/DM summary transport:
  - accepts thread summary events when payload is sufficient
  - accepts direct DM message payloads when payload is sufficient
  - triggers only lightweight thread refresh or targeted active-thread reconciliation when payload is partial

## Dedupe protections added
- Public live messages use existing stable message upsert/merge logic before rendering.
- Private live messages use existing private-message merge logic before rendering.
- Public sound stays gated by the existing incoming-audio baseline + observed-id tracking.
- DM sound stays gated by the existing DM observed-id tracking.
- Kill feed still uses `killFeedSeenKeys`, preventing replay across polling + live events.
- Unread remains driven by read watermarks and deduped message merges instead of raw event count alone.

## Hidden-panel polling reduced
- When public SSE is connected, public reconciliation polling slows down but does not stop.
- When private SSE is connected, private summary/thread polling slows down but does not stop.
- Driver-profile DM polling also uses a slower cadence when the private live transport is connected.

## Fallbacks that remain
- Polling remains active as a consistency check even during successful SSE sessions.
- Reconnect uses backoff instead of hot looping.
- Sign-out tears down both live transports.
- Visibility resume forces a safe poll + live-transport recheck.
- If capability detection fails, the app silently stays on polling.

## Developer diagnostic helper
- Added `window.getChatTransportDebugState()` for internal console diagnostics.
- The helper exposes transport mode/status, reconnect counts, last event ids, last merged keys, and reconciliation timestamps.
