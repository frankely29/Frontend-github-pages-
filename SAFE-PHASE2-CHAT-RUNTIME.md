# Safe Phase 2 Chat Runtime

## Current public chat poll path
- Public chat receive logic lives in `app.part2.js`.
- `syncChatPollingState()` is the main gate. When auth is ready it starts public polling, private polling, and live-transport probing together.
- `scheduleChatPoll(...)` owns the single public poll timeout and clears any prior timer before scheduling a new one.
- `chatPollOnce()` is the receive worker. It:
  - bails if another public poll is already in flight,
  - loads full history only when the public panel is actually open and the initial history is missing,
  - otherwise uses `chatFetchIncremental(...)` and `/chat/rooms/${CHAT_ROOM}?after=...&limit=...`.
- Public polling cadence changes by state:
  - visible/open chat: fast open cadence,
  - drawer closed: slower badge cadence,
  - document hidden: hidden cadence,
  - SSE-connected: even slower compatibility poll cadence remains enabled as a fallback/reconcile lane.

## Current private thread poll path
- `schedulePrivatePoll(...)` owns the DM summary/active-thread timeout loop.
- Each private cycle refreshes `/chat/private/threads` through `chatRefreshPrivateThreads()`.
- If a thread is active, the same cycle also calls `chatPollPrivateActiveThread(...)` so the open thread increments without pulling every thread history.
- Driver-profile DM polling is separate:
  - `openDriverProfileModal()` starts `startDriverProfileDmPolling()`.
  - `pollDriverProfileDmOnce()` fetches that profile thread incrementally while the modal remains open.

## Current unread state storage and clearing behavior
### Public unread
- `chatLastReadId` is persisted in localStorage at `tlc_chat_last_read_${CHAT_ROOM}`.
- `tlc_chat_read_baseline_${CHAT_ROOM}` marks that the first hidden/history baseline already seeded read state.
- Runtime unread count is tracked in `unreadChatCount` and surfaced into the dock badge through `updateChatUnreadBadge()`.
- Public unread is cleared by opening/reading the public panel, calling `markChatReadThroughLatestLoaded()`, or resetting chat state on sign-out.

### Private unread
- `privateUnreadByUserId` stores unread counts per thread in memory.
- `unreadPrivateCount` is derived from the per-thread map and fed into the dock badge.
- Opening a thread or profile DM zeroes the active thread's unread state while preserving the rest of the inbox.
- `chatResetState()` clears both public and private unread state on sign-out/auth teardown.

## Current sound trigger behavior
- `playChatTone('incoming')` and `playChatTone('outgoing')` remain the only sound entry points.
- Public incoming sound fires only for fresh incoming messages after baseline seeding/dedupe.
- Private incoming sound fires for fresh unseen DM events in the inbox thread path and the driver-profile DM path.
- Outgoing sound still plays on successful public, private, and profile-DM sends.
- Audio unlock/bootstrap still depends on first-user interaction and the existing WebAudio/HTMLAudio priming helpers.

## Current kill feed or equivalent live event feed behavior
- `app.part2.js` still creates/owns the kill-feed overlay.
- Public polling can push new public chat messages into the kill feed once bootstrap guards have seeded the initial history into `killFeedSeenKeys`.
- The kill feed stays active when the drawer is closed so live activity still appears without forcing the full panel open.
- There is no separate non-chat event stream in this repo snapshot; kill-feed behavior is still driven from chat receive paths.

## Current duplicate-risk points
- Public message side effects are split across:
  - initial history load,
  - incremental polling,
  - optimistic send/refresh flows,
  - SSE receive/merge hooks,
  - kill-feed updates,
  - unread state,
  - sound triggers.
- Private message side effects are split across:
  - inbox summary polling,
  - active-thread incremental polling,
  - profile-DM polling,
  - optimistic send/refresh flows,
  - SSE summary/message nudges.
- Duplicate-risk control currently depends on stable ids and shared merge helpers, including:
  - `chatSeenKeys`,
  - `chatLastSeen`,
  - `chatLatestMessageId`,
  - `privateLastMessageIdByUserId`,
  - kill-feed seen keys,
  - chat sound observed-id tracking.
- The riskiest failure mode would be letting polling and SSE both apply side effects without passing through the same dedupe gates.

## Planned SSE integration points and fallback strategy
### Capability detection
- `fetchChatLiveCapabilities()` checks `window.CHAT_LIVE_CONFIG` first, then calls `/chat/live/capabilities` when auth is ready.
- If the capability endpoint is missing, errors, or reports disabled, the runtime stores a disabled capability shape and remains in poll-only mode.
- If `window.EventSource` is unavailable, the runtime also stays in poll-only mode.

### Public SSE receive lane
- `ensureChatLiveTransport('public')` creates at most one public `EventSource`.
- `handlePublicLiveEvent(...)` merges live public messages into the existing message state and uses the same unread/kill-feed/sound dedupe helpers as polling.
- Public SSE still leaves the fallback poll lane enabled at a slower cadence for reconciliation and outage recovery.

### Private SSE receive lane
- `ensureChatLiveTransport('private')` creates at most one DM-summary `EventSource`.
- `handlePrivateLiveEvent(...)` applies thread-summary nudges directly and only reconciles the currently relevant thread/profile when needed.
- The runtime does not open one `EventSource` per DM thread.
- Hidden/private summary changes can trigger `schedulePrivateThreadsRefresh(...)`; active thread/profile changes can trigger `schedulePrivateThreadReconcile(...)`.

### Connection lifecycle safety
- `teardownChatLiveRuntime(...)` closes both public and private `EventSource`s on sign-out/reset.
- Reconnects use exponential backoff through `queueChatLiveReconnect(...)`.
- Reconnect storms are avoided by storing one reconnect timer per transport.
- Polling is rescheduled immediately whenever an SSE connection errors or closes so chat remains functional mid-outage.
