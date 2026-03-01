# Web UI

Docs index: [`../README_INDEX.md`](../README_INDEX.md)

Static, dependency-free front-end for mesdeparts.ch. Everything in this folder is served as-is (no build step), with ES modules and versioned filenames to keep long-lived caches safe to bust.

## Features
- Stop search with suggestions and favorites (stored locally; no account).
- Mobile search controls keep the favorites toggle inline (right side) with the search/nearby controls; it does not wrap below the search field on narrow viewports.
- Two bus views: by line (balanced by destination) or chronological; trains are always chronological.
- Filters for platform/line/train service plus “My favorites” mode.
- Self-hosted SBB clock + digital clock; base auto-refresh every 5 s (with jitter/backoff, ~3 h horizon).
- Multilingual (FR/DE/IT/EN), deep links via `?stationName=...&stationId=...`, installable PWA shell (API stays online).

## Entry points
- `index.html`: single-board experience with language switcher, favorites, filters, and the SBB clock iframe (`clock/`).
- `dual-board.html`: two boards side by side for kiosks/embeds, with separate station pickers and view/filter controls.
- `manifest.webmanifest` + `service-worker.js`: PWA shell; caches static assets, leaves API requests online-only. On activation after an update, the SW notifies all open clients (`SW_UPDATED` postMessage) so they auto-reload and pick up the new shell immediately.

## Architecture (versioned files)
- `main.v*.js`: boot; reads URL/localStorage defaults (`stationName`/`stationId`, language), wires event handlers, and starts refresh + countdown loops.
- `state.v*.js`: shared config/constants (refresh cadence, horizons, view modes, thresholds) and mutable `appState`.
- `logic.v*.js`: `realtime_api/backend` client (`/api/stops/search`, `/api/stops/nearby`, `/api/stationboard`), station resolve/nearby search, delay/remark computation, grouping/sorting, and network detection for line colors.
- `ui.v*.js`: DOM rendering of the board, clocks, station search with suggestions/nearby, filters (line/platform/train service), favorites popovers, view toggle, auto-fit watcher, and embed state publication.
- `i18n.v*.js`: minimal translations (FR/DE/IT/EN) + language persistence.
- `favourites.v*.js`: localStorage (`md_favorites_v1`) helpers; no backend.
- `infoBTN.v*.js`: info/help/realtime/credits overlay shown from the “i” button.
- `style.v*.css`: board + dual layout styles, network color tokens, popovers.
- `clock/`: self-hosted SBB clock assets (Apache 2.0); cached by the service worker for offline/instant loads.
- `config/network-map.json`: central network detection config (`operatorPatterns` primary, `stationPatterns` fallback, plus palette metadata).
- `scripts/networkMapUnknownOperators.mjs`: scans stationboard payloads and reports operators not matched by `network-map.json`.

## Data & refresh flow
- Default station is `Lausanne, motte`; query params or stored values override it. Deep links use `?stationName=...&stationId=...`.
- API base defaults to same-origin in deployment; on `localhost` it auto-targets `http://localhost:3001`. Override with `window.__MD_API_BASE__ = "https://your-backend-host"` when needed.
- `refreshDepartures` calls `/api/stationboard` (limit tuned to UI), rebuilds grouped rows (3 h horizon, train/bus split, line/platform filters, favorites-only mode, train service filters) and renders. Countdown column updates every 5 s from cached data.
- Backend stationboard responses now carry additive top-level `meta` (Model A): `serverTime`, `responseMode`, `requestId`, `totalBackendMs`, `skippedSteps`, `rtStatus`, `rtAppliedCount`, `rtFetchedAt`, `rtCacheAgeMs`, `alertsStatus`, `alertsFetchedAt`, `alertsCacheAgeMs`. `logic.v*.js` normalizes/persists it as `data.meta` and `appState.lastStationboardMeta` for diagnostics only (no polling or rendering cadence changes).
- RT status is rendered as a discreet persistent indicator (`Live data : •`): label color stays fixed/muted and only the dot color changes (green/orange/red/gray). Classification prefers `meta.rtStatus` when present; fallback is `rt.applied` / `rt.reason`. Base mapping: `applied` (or fallback `rt.applied=true` / `rt.reason=fresh`) -> green, `partial|mixed|degraded` -> orange, `missing|error|stale|unavailable` -> red, anything else -> gray. Poll-age guard then tightens the UI signal: `rtPollAgeMs > 25_000` forces amber for otherwise-green status, and `rtPollAgeMs > 45_000` forces red. Status is recomputed even on backend `204` responses using the last rendered payload.
- Bus line alert-column rendering is deterministic: show the extra line-column space only when at least one bus row has a positive delay signal (`status==="delay"` or `displayedDelayMin>0` or `delayMin>0`) and at least one bus row has renderable inline alert text; otherwise the line column stays collapsed.
- Bus line badges now apply a deterministic vivid fallback palette when network/operator line colors are missing, so unknown lines remain distinct without the legacy black/yellow default look.
- Line-alert popovers are anchored near the clicked row on all viewport sizes (no bottom sheet mode on mobile) and use a single-surface content layout with simple row separators.
- For single-alert departures, the popover header combines line + alert headline (`Line <id> – <headline>`), while the body shows the alert description text only.
- Refresh scheduling is timer-based (`REFRESH_DEPARTURES`, currently 5 s base) with Page Visibility/focus hooks: when the page returns to foreground, the app triggers an immediate refresh and performs drift catch-up if the scheduled timer slipped while backgrounded/throttled.
- Refresh requests are coalesced client-side: if a refresh is already in flight, new foreground/focus/manual refresh intents are queued and collapsed into a single follow-up fetch instead of launching parallel requests. See **Loading-hint state machine** below for the ownership rules.
- Incremental `since_rt` polling is context-guarded: the client sends `since_rt` only when a board is already applied for the same stop/language context, and includes `if_board=1` to allow backend `204` short-circuit only in that safe state.
- Kiosk/unattended safeguard: when the page is visible but no stationboard response has been received for an overdue window, the countdown loop triggers a cooldown-limited forced refresh to recover without manual reload.
- Stationboard fetches use `cache: "no-store"` on the browser side to avoid Safari/iPad HTTP cache staleness while preserving edge-cache behavior on `api.mesdeparts.ch`.
- Stale board guard: if the board looks stale/empty, the UI triggers a cache-bypassing refetch at most once per minute per station.
- Trip-details modal (`Détail du trajet`) uses abortable/time-bounded fetches and always exits loading state; non-OK/timeout failures show an error plus a retry button instead of indefinite loading.
- Trip-details candidate resolution now enforces mode compatibility (bus vs train) to prevent cross-mode misattachments, and unknown-mode rows prefer existing stationboard details over cross-mode guesses.
- Station search uses `/api/stops/search` and geolocation helper via `/api/stops/nearby`.
- Embeds: pages add a `dual-embed` class when framed; `publishEmbedState` exposes current board state to the parent.
- Dual board consumes embedded `boardLoading`/`boardNotice` state so each pane can surface the same live status text shown in the header controls.
- Network detection is config-driven: operator/agency matching is primary, route-id matching is secondary fallback, and station-name matching is last fallback when operator/route context is missing.
  - `dep.operator` (= `gtfs_agency.agency_name`, e.g. `”Städtische Verkehrsbetriebe Bern”`, `”TPG”`, `”TPN”`) is now included in every stationboard departure from the backend. It is matched case-insensitively against `operatorPatterns` in `config/network-map.json`. This is the most reliable detection method: it works for any stop the operator serves, including suburbs that don't match station-name patterns.
  - Swiss GTFS route_id format: `{category_code}-{line_number}-{variant}-{feed_version}` (e.g. `92-10-j26-1`). Category codes `91`, `92`, `96` are shared across ALL Swiss operators (TPG, Bern, BVB, VBL, TPN all use `92-`). Do NOT use bare `^92-` to identify a single operator. TPN is the only operator with a distinct sub-pattern: `^92-8\d{2}` (lines 803–891). This fix was applied to TPN's `routeIdPatterns` in this same changeset.
  - `stationPatterns` (stop name substring match, e.g. `”\\bbern\\b”`) is a last-resort fallback that fails for suburbs like Köniz, Ostermundigen, Gümligen, Wabern. Prefer `operatorPatterns`.
- **VBB (Bern city buses)** added as of 2026-02-27:
  - The Bern city bus operator's official `agency_name` in the Swiss GTFS feed is `”Städtische Verkehrsbetriebe Bern”` (not “Bernmobil”, which is the brand name). Network key: `vbb`, CSS class prefix: `line-vbb-`.
  - 41 line badge colors defined in `style.v*.css` (lines 3, 6–12, 16–17, 19–22, 26–31, 33–34, 36, 40–41, 43–44, 46–47, 100–107, 340, 451, 570, 631). Light-background colors carry explicit `color: #000000`.
  - `stationPatterns` covers main Bern stops plus inner suburbs (Köniz, Ostermundigen, Gümligen, Wabern, Liebefeld, Niederwangen, Bethlehem) as a fallback for stops not matched by `operatorPatterns`.
- If `config/network-map.json` fails to load (for example 404 on a misconfigured static deployment), logic falls back to an embedded default map so line/network colors still resolve.
- When network detection is unresolved or line-specific classes are missing, both row badges and “Served by lines” chips probe available CSS line classes across known network palettes before falling back to deterministic generic tones.
- “Served by lines” visibility is strict: it appears only on the single-board `index.html` bus board context (when bus lines are present) and is always hidden for train-board contexts and dual-board mode (`?dual=1` / `dual-mode`).

## How departure data is processed for the board

This is the ordered sequence `logic.v*.js` and `ui.v*.js` follow after the API response arrives:

```
1. Fetch (logic.v*.js → refreshDepartures in main.v*.js)
   GET /api/stationboard?stationId=...&limit=...&lang=...
   Response: { departures[], rt{}, alerts{}, meta{} }

2. Per-departure enrichment (logic.v*.js)
   For each dep in departures[]:
   a. Network detection (detectNetworkFromEntry):
      - dep.operator matched against operatorPatterns in network-map.json   ← primary
      - dep.route_id matched against routeIdPatterns                         ← secondary
      - station name matched against stationPatterns                         ← last resort
      → sets dep.network (e.g. "vbb", "tpg", "tl")
   b. Delay computation:
      - delayMin already set by backend; realtimeDeparture already ISO string
      - frontend computes displayedDelayMin and status ("on-time"/"delay"/"cancelled")
   c. Countdown:
      - diff between realtimeDeparture (or scheduledDeparture) and now, in minutes
      - updated every 5 s from cached data without re-fetching

3. Filtering (logic.v*.js, applied before grouping)
   Active filters checked in order:
   - favorites-only: skip departures not in md_favorites_v1
   - platform filter: skip if dep.platform ≠ selected platform
   - line filter: skip if dep.line ≠ selected line
   - train-service filter: skip specific IC/IR/RE/S services if toggled off
   - 3 h horizon: departures beyond appState.HORIZON_MINUTES are dropped

4. Sorting and grouping (logic.v*.js)
   TRAINS (route_type 2 / long-distance): always chronological, single flat list.
   BUSES (all other types):
   - "by line" view (default): group departures by line number;
     within each group, pick up to 2 destination branches and interleave
     scheduled times so the next bus per branch is always at the top.
     Groups are ordered by the earliest upcoming departure across both branches.
   - "chronological" view: flat list sorted by dep_sec (scheduled seconds
     since midnight), RT departure used for countdown display only.

5. Rendering (ui.v*.js)
   For each departure row:
   a. Badge: busBadgeClass() builds the CSS class:
      preferredNetworks = [dep.network, lineNetworks[line], lastBoardNetwork, currentNetwork]
      inferStyledNetworkForLine() probes each network's classPrefix + line number
      against the live CSS stylesheet — if background style exists, that class wins.
      Falls back to deterministic vivid palette (generic tones) if no match.
   b. Destination + delay chip: "+N min" shown in red when displayedDelayMin > 0.
   c. Platform chip: shown when platform is known; highlighted if platformChanged.
   d. Countdown: "Xm" or "now", refreshed every 5 s.
   e. Alert column (bus only): rendered only when ≥1 row has a delay AND ≥1 row
      has inline alert text — otherwise the column collapses to save space.
```

Summary of what comes from the backend vs what is computed frontend-side:
| Field | Origin |
| --- | --- |
| `scheduledDeparture`, `realtimeDeparture`, `delayMin` | Backend (RT merge) |
| `cancelled`, `platformChanged`, `platform` | Backend (RT merge) |
| `operator` | Backend (gtfs_agency JOIN) |
| `route_id`, `line`, `destination` | Backend (GTFS SQL) |
| `dep.network` (for badge color) | Frontend (detectNetworkFromEntry) |
| `displayedDelayMin`, `status`, countdown | Frontend (computed from backend fields) |
| Grouping, sort order, filter application | Frontend (logic.v*.js) |
| CSS class → badge color | Frontend (ui.v*.js + style.v*.css) |

## Running locally
- Static server only; no bundler needed:
  ```sh
  cd realtime_api/frontend
  python3 -m http.server 8000
  ```
  Then open http://localhost:8000.
- Tests (Node built-in): `npm test` from `realtime_api/frontend/` (checks key helpers in `logic.*.js`). `package.json` has no deps.
- Unknown operator audit:
  ```sh
  cd realtime_api/frontend
  npm run network-map:unknown-operators -- --base http://localhost:3001 --stops Parent8501120,Parent8576391
  ```

## Versioning & deploy notes
- JS/CSS filenames carry a version tag (`*.vYYYY-MM-DD-N.*`). When you bump assets, update references in `index.html`, `dual-board.html`, and the `CORE_ASSETS`/`LAZY_ASSETS` lists inside `service-worker.js`, plus the visible version tags in the HTML headers.
- `service-worker.js` derives its cache name from the asset list; keep the list in sync with the actual files so cache busting remains automatic. A changed asset list (or bumped `CACHE_REV`) produces a new `CACHE_NAME`, triggering install → activate → `SW_UPDATED` → client auto-reload on next visit.
- The UI is fully static: host this folder on any static host (Netlify/Vercel/S3/nginx/Apache). A `.htaccess` file is not used here; rely on versioned filenames for cache control.

## API target
- This UI is now wired for `realtime_api/backend` API routes only.
- It is not using the old `/locations` + `/stationboard` contract anymore.
- RT merge/source-of-truth stays backend-side; frontend does not implement platform-vs-parent stop-id matching logic.
- Each departure now includes `operator` = `gtfs_agency.agency_name` (e.g. `"Städtische Verkehrsbetriebe Bern"`, `"TPG"`, `"TPN"`). This is the authoritative source for `operatorPatterns` matching in `config/network-map.json`. It is resolved in the backend SQL via `LEFT JOIN gtfs_agency ag ON ag.agency_id = r.agency_id` and passed through `normalizeDeparture()` in `src/models/stationboard.js`. Note: `agency_id` (e.g. `"827"`) is the internal numeric FK used only for the JOIN — do NOT use it in `operatorPatterns`; use `agency_name` instead.
- For diagnostics only, backend `debug=1` exposes `debug.rt.tripUpdates` (including `rtEnabledForRequest`, `rtMetaReason`, scoped counters).

## Loading-hint state machine

`refreshDepartures` (`main.v*.js`) shows a loading hint ("Actualisation… / Refreshing…") only for
**foreground** calls (page-load, user-triggered, or focus-restore).  Background/scheduler calls
always set `showLoadingHint = false` and never toggle the hint.

Ownership rules enforced by the `finally` block:

| Situation | `showLoadingHint` | `pendingRefreshRequest` | `isStaleRequest()` | Result |
| --- | --- | --- | --- | --- |
| Normal foreground completion | `true` | `null` | `false` | Hint OFF, board published |
| Queued follow-up (new request arrived while this one was in-flight) | `true` | set | `false` | Hint OFF, follow-up dispatched |
| Stale / superseded (station changed mid-fetch) | `true` | `null` | `true` | Hint OFF, scheduler rescheduled |
| Background scheduler call | `false` | any | any | Hint unchanged (never set), board published if applicable |

The critical invariant: `setBoardLoadingHint(false)` is always called **before** any early `return`
path inside `finally` when `showLoadingHint` is `true`.  This prevents the hint from getting stuck
when the foreground request exits via the queued or stale branch.

Regression tests: `test/refreshHint.test.js` (8 tests including a `simulateRefreshFinallyBroken`
fixture that documents the pre-fix bug).

## Behavior/UX notes
- Filters/view changes are client-side only.
- Language, favorites, and last station are stored in `localStorage`; nothing leaves the browser.
- The service worker pre-caches the shell and serves navigations cache-first with background revalidation; API calls always hit the network. When a new SW version activates, it sends `SW_UPDATED` to all open tabs; `main.v*.js` listens and calls `location.reload()` so the new shell is served immediately without manual reloading. A `pageshow` + `persisted` listener in `main.v*.js` also handles iOS bfcache restoration (page thawed from freeze bypasses the SW entirely) by triggering an immediate reload.
