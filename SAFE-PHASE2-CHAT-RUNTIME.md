# SAFE PHASE 2 Chat Runtime Baseline (Pre-change)

This document records the observed frontend chat/runtime behavior before the Safe Phase 2 additive live-delivery changes.

## Files reviewed
- `app.part2.js`
- `app.js`
- `app.part3.js` (confirmed not part of the chat runtime)
- `index.html`

## Public chat polling: where it starts
- Public chat polling state is controlled entirely in `app.part2.js`.
- `syncChatPollingState()` decides whether chat polling should run based on auth state, panel visibility, and current tab.
- `startChatPolling()` calls `scheduleChatPoll({ immediate: true })`.
- `scheduleChatPoll()` chooses the interval from:
  - `CHAT_POLL_MS` (`1500ms`) when public chat tab is open and visible.
  - `CHAT_CLOSED_POLL_MS` (`5000ms`) when signed in but panel/tab is not actively open.
  - `CHAT_HIDDEN_POLL_MS` (`12000ms`) when the document is hidden.
- `chatPollOnce()` performs the actual HTTP poll against `/chat/rooms/${CHAT_ROOM}` using:
  - `after=<chatLastSeen>` when a watermark exists.
  - `limit=50` by default.
- Public polling is restarted from several lifecycle points:
  - `wireChatPanel()` after opening the chat drawer.
  - `syncChatPollingState()` after auth/UI changes.
  - `visibilitychange` handler in `app.part2.js` schedules an immediate poll when the page becomes visible.
  - `setAuthUI()` in `app.js` calls `window.syncChatPollingState()`.

## DM polling: where it starts
- Inbox/thread-list + active private thread polling are also managed in `app.part2.js`.
- `syncChatPollingState()` starts private polling via `startPrivatePolling()` whenever the user is signed in.
- `startPrivatePolling()` calls `schedulePrivatePoll({ immediate: true })`.
- `schedulePrivatePoll()` chooses the interval from:
  - `PRIVATE_CHAT_OPEN_POLL_MS` (`3500ms`) when private tab is open and a thread is active.
  - `PRIVATE_CHAT_CLOSED_POLL_MS` (`7500ms`) when signed in but the private panel/thread is not actively visible.
  - `PRIVATE_CHAT_HIDDEN_POLL_MS` (`15000ms`) when the page is hidden.
- Each private poll cycle does two things:
  - `chatRefreshPrivateThreads()` refreshes `/chat/private/threads`.
  - `chatPollPrivateActiveThread()` fetches incremental messages for the open thread using `since_id=<lastMessageId>`.
- Driver-profile DM polling is separate from the inbox drawer:
  - `openDriverProfileModal()` starts `startDriverProfileDmPolling()` for non-self profiles.
  - `scheduleDriverProfileDmPoll()` uses `DRIVER_PROFILE_DM_POLL_OPEN_MS` (`4000ms`) or `DRIVER_PROFILE_DM_POLL_HIDDEN_MS` (`14000ms`).
  - `pollDriverProfileDmOnce()` calls `fetchDriverProfileDmThread(userId, { after: latestMessageId, markRead: true })`.

## Where unread state is stored
- Public unread runtime state:
  - `unreadChatCount` in memory.
  - `chatLastReadId` in memory and localStorage under `tlc_chat_last_read_${CHAT_ROOM}`.
  - A one-time baseline flag in localStorage under `tlc_chat_read_baseline_${CHAT_ROOM}`.
- Private unread runtime state:
  - `privateUnreadByUserId` in memory, keyed by other user id.
  - `unreadPrivateCount` is derived from `privateUnreadByUserId` in `updateChatUnreadBadge()`.
- UI badge storage:
  - Total unread is surfaced by setting `dockChat.dataset.unread` in `updateChatUnreadBadge()`.

## Where unread state is cleared
- Public unread is cleared by:
  - `clearChatUnreadBadge()`.
  - `markChatReadThroughLatestLoaded()` which also advances `chatLastReadId` to `chatLatestMessageId`.
  - `switchChatTab('public')`/open-panel flows indirectly via `syncChatPollingState()` + render paths when the public panel is visible.
- Private unread is cleared by:
  - `openPrivateConversation()` sets `privateUnreadByUserId[uid] = 0`.
  - `chatPollPrivateActiveThread({ visible: true })` keeps active-thread unread at zero.
  - `openDriverProfileModal()` and `pollDriverProfileDmOnce()` zero unread for the active driver-profile DM.
- Sign-out clears all chat runtime state through `chatResetState()` from `clearAuth()` in `app.js`.

## Where kill feed receives new messages
- Kill feed DOM is created in `app.part2.js` as `#killFeed` if it does not already exist.
- New public chat messages are shown through `showKillFeed(msgs)`.
- `chatPollOnce()` calls `showKillFeed(loadedMsgs)` after incremental public polls, but only after bootstrap guards allow it.
- `seedKillFeedSeenKeys(msgs)` seeds existing history into `killFeedSeenKeys` so initial history does not replay into the feed.

## Where sound notifications are played
- Public/DM sound state lives in `chatSoundRuntime` and related helpers in `app.part2.js`.
- Sounds are played via `playChatTone('incoming')` and `playChatTone('outgoing')`.
- Public incoming sound path:
  - `chatPollOnce()` computes `freshIncoming` via `collectFreshIncomingMessagesForAudio()` and plays one incoming tone if any fresh incoming messages remain after suppression.
- Private/DM incoming sound path:
  - `chatPollPrivateActiveThread()` plays one incoming tone when hidden and `collectFreshIncomingDriverProfileDm(incoming)` reports fresh other-user messages.
  - `pollDriverProfileDmOnce()` plays one incoming tone for fresh driver-profile DMs.
- Outgoing tones are played after successful send flows for public chat, private chat, and driver-profile DMs.
- Audio unlock/bootstrap is handled by first-interaction listeners and the WebAudio/HTMLAudio priming helpers.

## Where history is loaded
- Public history:
  - `ensureChatNotificationsBootstrapped()` loads `/chat/rooms/${CHAT_ROOM}?limit=60` before bootstrapping unread/sound state.
  - `wireChatPanel()` also ensures the visible public list is loaded/rendered.
- Private thread list history:
  - `chatRefreshPrivateThreads()` loads `/chat/private/threads`.
- Private conversation history:
  - `openPrivateConversation()` loads `/chat/private/${userId}?limit=60&mark_read=true`.
- Driver-profile DM history:
  - `openDriverProfileModal()` loads `fetchDriverProfileDmThread(userId, { limit: 30, markRead: true })`.

## Where hidden panels continue background polling
- Public chat keeps polling while closed:
  - `scheduleChatPoll()` uses `CHAT_CLOSED_POLL_MS` or `CHAT_HIDDEN_POLL_MS` instead of stopping entirely.
- Private chat keeps polling while closed:
  - `schedulePrivatePoll()` continues refreshing thread summaries and active thread increments on its closed/hidden cadence.
- Driver-profile DM keeps polling while the modal is open, even if the page visibility changes, with a slower hidden cadence.

## Existing lastSeen / since / message-id tracking
- Public chat tracking:
  - `chatLastSeen` stores a cursor from `chatMsgCursor(msg)` (`id` first, then timestamp fallback).
  - `chatLatestMessageId` stores the highest known numeric public message id.
  - `chatLastReadId` stores the persisted read watermark.
  - `chatSeenKeys` stores known public message keys.
- Private/DM tracking:
  - `privateLastMessageIdByUserId[uid]` stores the latest numeric id per thread.
  - Incremental private fetches use `since_id` for inbox and `after` for driver-profile DM helper endpoints.
  - `privateMessagesByUserId` stores merged thread history in memory.
- Sound-specific tracking:
  - `chatSoundRuntime.lastObservedIncomingId` for public incoming audio dedupe.
  - `chatSoundRuntime.dmLastObservedIncomingId` for DM incoming audio dedupe.
- Kill-feed tracking:
  - `killFeedSeenKeys` prevents replay in the overlay.

## Existing duplicate risks before Safe Phase 2 changes
- Public and private messages already have merge/upsert logic, but receive paths are split across:
  - initial history/bootstrap,
  - incremental polling,
  - send-response optimistic merge/fallback refresh,
  - driver-profile DM modal,
  - kill-feed overlay,
  - sound/unread side effects.
- Current risks observed:
  - side effects are not fully centralized, so a future second transport (such as SSE) would duplicate unread/sound/feed work unless carefully deduped.
  - public unread increments can happen in `showKillFeed(msgs)` while rebuilds also depend on `chatLastReadId`.
  - DM sound dedupe currently relies on `dmLastObservedIncomingId`, which is driver-profile oriented and could double-fire if another live path were added without a shared dedupe gate.
  - hidden-panel polling still performs regular network work even when only badge/summary updates are needed.

## Existing fallback behavior on network errors
- Public chat:
  - `chatPollOnce()` catches errors, logs `chat poll failed`, bumps an error stat, and polling continues on the next scheduled timeout.
  - bootstrap retries are guarded by `chatInitialHistoryRetryQueued` / follow-up polling.
- Private inbox/thread polling:
  - `chatFetchPrivateThreads()` logs errors and returns `[]` on non-abort failure.
  - `schedulePrivatePoll()` always reschedules after each run; failures do not stop the loop.
- Driver-profile DM polling:
  - `pollDriverProfileDmOnce()` swallows errors and the scheduler continues.
- Auth/sign-out fallback:
  - `clearAuth()` calls `chatResetState()` and `stopChatPolling()` so stale timers and messages do not survive sign-out.
- Overall current safety model:
  - HTTP polling is the required receive path today.
  - If requests fail transiently, existing timers continue attempting later polls rather than hard-failing the chat UI.
