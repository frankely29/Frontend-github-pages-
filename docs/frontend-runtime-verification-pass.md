# Frontend Runtime Verification Pass (/assistant/guidance)

Date: 2026-04-07 (UTC)

## Scope
This pass verifies that the frontend wiring for `/assistant/guidance` is correct and that local assistant fallback remains intact.

> Note: In this environment, live browser DevTools interaction is not available, so this is a **code-path verification** with explicit runtime follow-ups for a browser session.

## 1) Signed-in guidance request triggers

### Implemented request
- Guidance is fetched from `${apiBase}/assistant/guidance` with credentials included.
- Query includes frame time, location, and mode flags.

Code evidence:
- `fetchGuidance(...)` builds `/assistant/guidance?...` and executes `fetch(url, { credentials: "include" })`.

### Trigger coverage
The assistant recompute path that can invoke `fetchGuidance(...)` is connected to:
- Initial assistant render bootstrap (`renderWidget()`, `mirrorRecommendLine()`, then recompute on frame/location events)
- Frame change (`team-joseo-frame-rendered` / `updateAssistantForFrame`)
- Location change (`tlc-user-location-updated`)
- Mode change (`tlc-mode-changed`)
- Trip save/pickup refresh (`tlc-pickup-recorded`)

## 2) Recommendation line behavior

- Recommendation line is mirrored via a single writer: `mirrorRecommendLine()`.
- It formats one line as `AI Assistant: <primary> • <secondary>`.
- Server-guided primary line values are exactly:
  - `Stay in current area`
  - `Micro-reposition nearby`
  - `Move toward <zone>`
  - `Wait for dispatch`

This matches expected driver-style guidance and prevents duplicate banner logic in this module.

## 3) AI Assistant widget behavior

- Existing widget is rendered in place (`dockMount.innerHTML`) by `renderWidget()`.
- Widget and recommendation line both derive from the same builders:
  - `buildAssistantPrimaryLine()`
  - `buildAssistantSecondaryLine()`
- Practical context is included in expanded panel when server guidance is active:
  - Tripless minutes
  - Stationary/movement minutes
  - Dispatch uncertainty
  - Target zone (when available)

## 4) Navigation behavior

Navigation ownership logic (`applyNavOwnership()`):
- If server guidance action is `MOVE_NEARBY` and target coordinates exist, nav destination is set.
- For server actions `HOLD`, `MICRO_REPOSITION`, or `WAIT_DISPATCH`, nav destination is cleared (not forced).
- Local fallback logic still sets nav only for move-class actions (`LEAVE_NOW`/`MOVE_SOON`) with a target.

## 5) Fallback safety

Fallback safety is explicit:
- Non-OK/401/403/malformed guidance payloads set guidance error state and return `null`.
- Recompute path then marks `guidanceSource = "local"` and continues with local guidance builders.
- Widget status line communicates local fallback mode.
- Recommendation line still uses local `buildAssistantPrimaryLine()/SecondaryLine()` output when server guidance is unavailable.

## 6) Save-trip integration

- Pickup/trip-save refresh event `tlc-pickup-recorded` triggers urgent recompute.
- This keeps assistant refresh integrated with post-save flow without suppressing UI updates.

## 7) Regression smoke surface (code-level)

No direct changes to map/timeline/hotspot/chat/leaderboard/day tendency/nav button subsystems were needed for this pass.
The assistant hooks are event-based and scoped to assistant recomputation + nav destination ownership.

## Manual DevTools checks still required in a browser session

To fully satisfy runtime PASS criteria in the live app, run this exact checklist in browser DevTools (Network tab):

1. Signed in + location allowed:
   - Confirm `GET /assistant/guidance` on initial render, frame change, location change, mode change, and trip save.
   - Confirm HTTP 200 for signed-in + location-available cases.
2. Verify a single recommendation line with expected action wording.
3. Verify a single AI Assistant widget (not duplicated), matching same guidance as recommendation line.
4. Verify nav handoff only on `MOVE_NEARBY`; no forced nav for hold/micro/wait.
5. Simulate failure (auth/location/request) and verify local fallback still renders guidance.
6. Save trip and verify assistant refresh and no pickup/save regressions.
7. Run the smoke checks (map/timeline/hotspots/chat/leaderboard/day tendency/nav button).

## PASS assessment

- **Code-path PASS** for endpoint usage, action mapping, shared UI guidance source, nav gating, and local fallback behavior.
- **Runtime DevTools PASS pending** direct browser confirmation of request timings/status codes and UI non-duplication in a live signed-in session.
