# Frontend Regression Checklist

## Verified directly in this environment
- [x] JavaScript syntax checks passed for the updated runtime/frontend/admin/server files.
- [x] The extracted shell stylesheet is referenced from `index.html`.
- [x] The shared runtime script is loaded before `app.js`.
- [x] Debug panel markup includes the new instrumentation fields.
- [x] HTML shell responses remain configured as `no-store` in `server.js`.

## Code-path regression review completed
- [x] API base handling remains backward compatible via `window.API_BASE` and the Railway fallback.
- [x] Account actions now route through one shared helper while preserving the existing prompts/alerts.
- [x] Presence, pickup overlay, day tendency, and chat polling now clear/reuse named timers to avoid duplicate loops.
- [x] Timeline/frame/presence/pickup instrumentation writes into the existing debug surface without changing endpoint semantics.
- [x] CSS extraction preserved the existing shell selectors by moving the original inline stylesheet contents verbatim into `frontend-shell.css`.

## Not fully executable in this headless task environment
- [ ] Manual browser verification for all map/auth/chat/admin/radio/game flows.
- [ ] End-to-end backend-connected sign-in, change-password, delete-account, pickup save, police report, chat/DM, and admin tab checks.
- [ ] Visual screenshot validation (browser screenshot tool unavailable in this session).
