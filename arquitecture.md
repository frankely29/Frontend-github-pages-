# TLC Map System Architecture

## 1) Overview

The TLC map platform is a data-driven NYC hotspot system designed to help FHV/Uber drivers optimize earnings by showing where demand is strongest throughout the day.

### Core product behavior
- Uses **20-minute bins** as the default demand time window.
- Aligns all map playback and selection to **NYC local time**.
- Exposes a timeline slider so drivers can inspect historical/expected demand windows.
- Colors zones by demand strength using the bucket scheme:
  - **Green** (highest)
  - **Purple**
  - **Blue**
  - **Sky**
  - **Yellow**
  - **Red** (lowest)

---

## 2) Repository Split

The system is intentionally split into two repositories with different runtime responsibilities:

### Frontend repository (GitHub Pages)
- Static application delivery.
- Contains the browser client and interaction logic.
- Confirmed files:
  - `index.html`
  - `app.js`

### Backend repository (Railway)
- API + compute services + community persistence.
- Generates map frames from raw trip inputs.
- Serves authenticated community endpoints and event/presence data.
- Confirmed files:
  - `main.py`
  - `build_hotspot.py`
  - `requirements.txt`
  - `Procfile`

### Why this split exists
- **Static hosting fit:** frontend is pure static assets and works well on GitHub Pages.
- **Compute + storage fit:** backend needs CPU/data processing and persistent `/data` volume for parquet, zone geometry, generated frames, and SQLite DB.
- **Operational separation:** UI deploys stay fast/simple while backend can evolve independently for data generation, auth, and API scaling.

---

## 3) Frontend Architecture (detailed)

Backend base URL is configured in the frontend and should be treated as a placeholder such as:
- `<RAILWAY_BASE_URL>`

### `index.html` responsibilities
- Defines the Leaflet map container and base CSS.
- Provides legend layout and minimize/toggle behavior shell.
- Hosts `lockedOverlay` sign-in UI with:
  - Email
  - Password
  - Driver display name
  - Ghost mode preference
- Includes top-level control buttons and UI anchors for:
  - Sign in / Sign out
  - Navigate
  - Staten Island Mode
  - Manhattan Mode (button created and managed by JS)
  - Ghost Mode
  - Police
  - Pickup
- Defines bottom controls and status surfaces:
  - Time slider
  - Slider bubble/value indicator
  - Weather badge
  - Radio controls

### `app.js` responsibilities (major modules)

#### A) Timeline + frame loading
- Calls `GET /timeline` to populate available bins and slider domain.
- Calls `GET /frame/{idx}` to fetch polygon frame data for the selected index.

#### B) NYC time alignment + slider initialization
- Converts/aligns available timeline values to NYC-local expectations.
- Initializes slider defaults and behavior based on fetched timeline metadata.

#### C) Polygon rendering + labels
- Renders zone polygons with fill colors from computed bucket values.
- Draws per-zone labels with zoom-sensitive visibility rules.
- Applies map/zoom event updates so labels remain legible.

#### D) Staten Island Mode
- Applies a **local percentile recolor strategy** specific to Staten Island context.
- Helps avoid borough-scale compression effects where Staten Island can appear muted.

#### E) Manhattan Mode
- Applies Manhattan-focused scoring adjustments.
- Excludes core Manhattan regions where necessary for alternate recommendation behavior.

#### F) Recommendation engine + Navigate
- Produces recommendations weighted toward **Blue+ / Purple / Green** opportunities.
- Drives target selection and navigation URL generation.
- Integrates with the Navigate control for external routing handoff.

#### G) Auto-center behavior
- Supports auto-centering on driver position.
- Temporarily suppresses recenter during programmatic camera moves to prevent UX jitter.

#### H) GPS self marker + heading
- Tracks the current driver location as a dedicated map marker.
- Uses heading/bearing logic for directional UI (navigation arrow orientation + label context).

#### I) Weather + optional effects overlay
- Fetches weather from Open-Meteo.
- Updates weather badge/status in UI.
- Supports optional FX canvas overlay when enabled.

#### J) Radio controls
- Manages station/input controls wired from bottom UI.

#### K) Community + auth
- Persists client identity/session values in localStorage keys:
  - `community_token_v1`
  - `community_email_v1`
  - `community_display_name_v1`
- Signup/login flows:
  - `POST /auth/signup`
  - `POST /auth/login`
- Profile flows:
  - `GET /me`
  - `POST /me/update` (display name + ghost mode)
- Presence sync:
  - periodic `POST /presence/update`
  - periodic pull from `GET /presence/all`

---

## 4) Backend Architecture (detailed)

### `main.py`
Primary API service (FastAPI) with frame delivery, generation controls, auth/community, and event endpoints.

#### `/data` volume layout
- Persistent data root is mounted at `/data`.
- Frame artifacts live under `/data/frames`.
- Timeline manifest is `/data/frames/timeline.json`.

#### Frame/data endpoints
- `GET /status`
- `POST /generate`
- `GET /generate_status`
- `GET /timeline`
- `GET /frame/{idx}`
- `POST /upload_parquet`
- `POST /upload_zones_geojson`

#### Community/auth endpoints
- `POST /auth/signup`
- `POST /auth/login`
- `GET /me`
- `POST /me/update`

#### Presence + event endpoints
- `POST /presence/update`
- `GET /presence/all`
- `POST /events/police`
- `POST /events/pickup`

#### Admin endpoints
- `GET /admin/users`
- `POST /admin/users/disable`
- `POST /admin/users/reset_password`

#### Community database
- SQLite database path is controlled by `COMMUNITY_DB`.
- Default location: `/data/community.db`.
- Includes user, presence, and events persistence.
- Relevant modeled attributes include **display_name** and **ghost_mode**.

#### Auth requirements
- `JWT_SECRET` is required for token signing/validation.
- `/presence/all` requires `Authorization: Bearer <token>`.

### `build_hotspot.py`
Batch frame generation pipeline for hotspot scoring.

#### Inputs
- Reads parquet inputs from `/data/*.parquet`.
- Requires zone geometry file at `/data/taxi_zones.geojson`.

#### Processing
- Uses DuckDB in-memory for analytic aggregation.
- Uses a temp directory rooted under `/data` for intermediate processing when needed.

#### Outputs
- Writes `/data/frames/timeline.json`.
- Writes `/data/frames/frame_*.json` payloads consumed by frontend timeline playback.

#### Scoring + colors
- Produces ratings in range **1–100**.
- Bucket/color mapping:
  - `>= 90` → Green
  - `>= 80` → Purple
  - `>= 65` → Blue
  - `>= 45` → Sky
  - `>= 25` → Yellow
  - else → Red
- Core scoring idea uses **percentile-based normalization** to remain robust against outliers.

### `requirements.txt`
Declares runtime dependencies (major examples):
- `fastapi`
- `uvicorn`
- `duckdb`
- `geopandas`
- plus related geospatial/data/auth utilities used by service code.

### `Procfile`
Defines process startup command (uvicorn entrypoint) for Railway runtime.

---

## 5) Data Flow Diagrams (text)

### A) Frontend runtime flow
1. Browser requests static assets from GitHub Pages.
2. GitHub Pages serves `index.html` + `app.js`.
3. `app.js` initializes map, timeline controls, and auth/presence loops.

### B) Frame API flow
1. `app.js` calls `GET <RAILWAY_BASE_URL>/timeline`.
2. Response defines available timeline bins and slider options.
3. On selection/playback, `app.js` calls `GET <RAILWAY_BASE_URL>/frame/{idx}`.
4. Response polygons are rendered and recolored in Leaflet.

### C) Data generation flow
1. Backend reads input files from `/data`:
   - parquet data
   - `taxi_zones.geojson`
2. Generation process computes normalized hotspot scores.
3. Backend writes frame outputs to `/data/frames`.
4. API serves timeline + frames directly from generated artifacts.

### D) Community/auth flow
1. User signs up/logs in via `/auth/signup` or `/auth/login`.
2. Backend returns token; frontend stores local session keys.
3. Frontend sends periodic `/presence/update` heartbeats.
4. Frontend reads `/presence/all` (Bearer token required) to show active drivers.

---

## 6) Marker Accuracy / Zoom Drift Incident Report

### Symptom
When zooming out, some other-driver markers appeared to “move” relative to true positions.

### Root causes (high-level)
- Oversized `divIcon` bounds and/or non-centered anchors.
- Coordinate-to-pixel offset conversions applied in ways that effectively displaced marker bodies.

### Final rule enforced
- **All driver marker bodies must stay pinned to true reported `lat/lng` at every zoom level.**
- Collision handling is solved by shifting **labels only**, never the marker anchor position.

### Current implementation summary
- Other-driver icon uses **40x40** size with centered anchor.
- Label is translated independently via CSS `transform: translate(...)`.
- Collision logic computes `labelDx` / `labelDy` only.
- Marker placement always uses raw `drv.lat` / `drv.lng`.

---

## 7) Configuration & Security

### Environment variables (names only)
- `DATA_DIR`
- `FRAMES_DIR`
- `COMMUNITY_DB`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_BOOTSTRAP_TOKEN`
- `DEFAULT_BIN_MINUTES`
- `DEFAULT_MIN_TRIPS_PER_WINDOW`
- `TRIAL_DAYS`
- `TOKEN_TTL_SECONDS`
- `PRESENCE_STALE_SECONDS`

### Security notes
- Never commit `JWT_SECRET` or any token values.
- Frontend stores session token client-side (localStorage), not in repository code.
- `/presence/all` requires `Authorization: Bearer <token>`.
- Ghost mode privacy is enforced server-side by excluding hidden drivers from shared presence results.

---

## 8) Deployment / Ops Checklist

### Frontend (GitHub Pages)
- Push frontend branch to `main` (or configured Pages source branch).
- GitHub Pages serves repository root static files.

### Backend (Railway)
- Deploy backend service to Railway.
- Attach persistent volume mounted at `/data`.
- Ensure required inputs exist:
  - `taxi_zones.geojson`
  - one or more parquet files
- If timeline is not present, call `POST /generate`.

### Troubleshooting quick guide
- **Issue:** “timeline not ready”  
  **Action:** call `POST /generate` and wait for `/generate_status` completion.

- **Issue:** “Missing Bearer token”  
  **Action:** sign in again and verify token exists in localStorage.

- **Issue:** cannot see other drivers  
  **Action:** verify location permission, check ghost mode settings, and ensure peer presence is not stale.

---

## File Trees (confirmed)

### Frontend repo (`frankely29/Frontend-github-pages-`)
```text
.
├── index.html
├── app.js
└── arquitecture.md
```

### Backend repo
```text
.
├── main.py
├── build_hotspot.py
├── requirements.txt
└── Procfile
```

## Incident: Railway frontend was not pulling backend polygons (teamjoseo)

### Symptoms
- GitHub Pages rendered polygons correctly, but Railway teamjoseo did not render polygons.
- Backend health and data endpoints (`/status`, `/timeline`, `/frame/{idx}`) were responding correctly, so volume/data generation was not the issue.

### Root cause
- Railway frontend was serving a different JS build (or stale cached JS) than the intended frontend code.
- The running JS lacked the correct backend base URL wiring, so it was not calling the real backend used for timeline/frame data.

### Fix
- Ensure `index.html` loads the correct `app.js` as the single source of truth and apply cache-busting on the script URL.
- Add a temporary debug panel/logging path to verify timeline load, frame load, and `setData` execution.
- After applying the correct script/build, teamjoseo resumed polygon rendering.

### Regressions introduced
- Manhattan Mode broke.
- Staten Island Mode broke.
- Ghost Mode (auth/profile toggle behavior) broke.
- Self GPS/nav arrow behavior broke.

### Restoration plan
- Re-import the known-working feature blocks from `old_app.js` into current `app.js` with minimal diff.
- Keep current polygon rendering pipeline and backend paths intact.
- Restore only Manhattan/Staten/Ghost/Self GPS flows and verify they work without breaking teamjoseo polygon rendering.

