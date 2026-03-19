# SAFE PHASE 2 Chat Changelog

## What was completed in this pass
- Preserved the existing optional SSE architecture in `app.part2.js`.
- Strengthened capability normalization so the frontend can safely read public/private live URLs from more capability payload shapes without enabling SSE accidentally.
- Preserved the existing fallback rule: if capability discovery is missing, disabled, unsupported, or fails, the app stays in polling mode without throwing transport errors into the UI.

## Capability discovery contract
- The frontend still checks `window.CHAT_LIVE_CONFIG` first.
- If inline config is not available, it still probes `GET /chat/live/capabilities`.
- This pass intentionally does **not** switch live URL discovery over to `/chat/live/status`.

## Capability normalization details
- Public and private live URLs are normalized independently.
- Supported URL field variants now include direct `url` forms plus common SSE/stream aliases.
- Explicit disabled flags still win over inferred enablement.
- SSE is enabled only when a concrete URL is present.

## What remains intentionally unchanged
- HTTP send paths are unchanged.
- Polling remains active for public chat, private summaries, active DM reconciliation, and driver-profile DM reconciliation.
- Live events still feed the existing dedupe/unread/kill-feed/sound merge logic.
- Reconnect still uses backoff.
- Reconciliation polling still runs at a lower cadence even when SSE is connected.

## Safety outcomes
- No EventSource-mandatory path was introduced.
- No full-history refetch on every live event was introduced.
- No chat-live coupling was added to map rendering or presence repaint logic.
