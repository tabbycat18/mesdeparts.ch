# AGENTS.md
## 1) Purpose
- Give contributors and AI agents a fast, verified map of the active stack.
- Minimize repeated code-search by using README-first onboarding.
- Keep runtime truth explicit when compatibility/shim files exist.

## 2) Read-this-first order (mandatory)
- `realtime_api/README_INDEX.md`
- `realtime_api/README_realtime_api.md`
- `realtime_api/backend/README_backend.md`
- `realtime_api/backend/README_SQL.md`
- `realtime_api/backend/README_src.md`
- `realtime_api/backend/scripts/README_scripts.md`
- `realtime_api/docs/INDEX.md`

Loader/logic canonical docs:
- Runtime map and quick links: `realtime_api/README_INDEX.md`
- Deep explanations (file-level): `realtime_api/backend/README_src.md` (`src/loaders`, `src/logic`, `src/rt`)

If context is still missing after this order, then inspect code.

## 3) Verified repo layout
- `realtime_api/`: active stack (backend + frontend + edge).
- `realtime_api/backend/`: active API, GTFS/RT logic, pollers/scripts.
- `realtime_api/frontend/`: active static web UI.
- `realtime_api/edge/`: active Cloudflare Worker.
- `realtime_api/docs/`: active operations documentation (zero-downtime GTFS refresh docs + runbooks).
- `legacy_api/`: archive-only legacy stack (do not use for active deploys).

## 4) Authoritative runtime entrypoints (verified in code)
- Backend process entrypoint: `realtime_api/backend/server.js`
- Mounted stationboard route: `/api/stationboard` via `realtime_api/backend/src/api/stationboardRoute.js`
- Mounted stop-search route: `/api/stops/search` via `realtime_api/backend/src/api/stopSearchRoute.js`
- Stationboard orchestrator: `realtime_api/backend/src/api/stationboard.js`
- Canonical stationboard builder: `realtime_api/backend/src/logic/buildStationboard.js`
- Builder compatibility shim: `realtime_api/backend/logic/buildStationboard.js` (re-export only)
- Scoped RT parsed-table loader (default): `realtime_api/backend/src/rt/loadScopedRtFromParsedTables.js`
- Alerts parsed-table loader (default): `realtime_api/backend/src/rt/loadAlertsFromParsedTables.js`
- Blob/debug loaders: `realtime_api/backend/src/rt/loadScopedRtFromCache.js`, `realtime_api/backend/src/rt/loadAlertsFromCache.js`
- Shared feed cache/decode module: `realtime_api/backend/loaders/loadRealtime.js`
- Pollers:
  - `realtime_api/backend/scripts/pollFeeds.js`
  - `realtime_api/backend/scripts/pollLaTripUpdates.js`
  - `realtime_api/backend/scripts/pollLaServiceAlerts.js`
- Frontend entrypoint: `realtime_api/frontend/index.html`
- Frontend stationboard refresh/fetch loop: `realtime_api/frontend/v20260223-1.main.js`, `realtime_api/frontend/v20260223-1.logic.js`
- Edge worker entrypoint: `realtime_api/edge/worker.js`

## 5) Compatibility/deprecated files (verified)
- `realtime_api/backend/routes/searchStops.js` exists but is not mounted by `server.js`.
- `realtime_api/backend/sql/legacy/schema_gtfs.sql` is legacy-only archival SQL (not active runtime/cutover SQL).
- Historical incident/debug markdown notes are archived in `realtime_api/docs/archive/problem-a/`.
- `legacy_api/*` remains archived for reference; active runtime/deploy is under `realtime_api/*`.

## 6) Where to change X
| Goal | Primary file(s) |
| --- | --- |
| GTFS refresh/cutover SQL ownership and run order | `realtime_api/backend/README_SQL.md` |
| Stationboard route params/headers/204 | `realtime_api/backend/src/api/stationboardRoute.js` |
| Stationboard in-flight request coalescing / stale fallback cache | `realtime_api/backend/src/api/stationboardRoute.js` |
| Stationboard client cache policy (browser no-store + CDN cache hints) | `realtime_api/backend/src/api/stationboardRoute.js`, `realtime_api/edge/worker.js` |
| Stationboard response/meta/alerts wiring | `realtime_api/backend/src/api/stationboard.js` |
| Core board SQL + RT merge pipeline | `realtime_api/backend/src/logic/buildStationboard.js` |
| Departure `operator` field (agency_name exposed for frontend network/badge detection) | `realtime_api/backend/src/sql/stationboard.sql` (LEFT JOIN gtfs_agency), `realtime_api/backend/src/logic/buildStationboard.js` (set agency_name\|\|agency_id), `realtime_api/backend/src/models/stationboard.js` (add to normalizeDeparture allowlist) |
| Stationboard debug RT diagnostics (`rtEnabledForRequest`, `rtMetaReason`, scoped counters) | `realtime_api/backend/src/logic/buildStationboard.js`, `realtime_api/backend/src/api/stationboard.js` |
| Loader module explanation (feed cache/decode) | `realtime_api/backend/loaders/loadRealtime.js`, docs in `realtime_api/backend/README_src.md` |
| RT/alerts scoped loader explanation | `realtime_api/backend/src/rt/loadScopedRtFromParsedTables.js`, `realtime_api/backend/src/rt/loadAlertsFromParsedTables.js`, `realtime_api/backend/src/rt/loadScopedRtFromCache.js`, `realtime_api/backend/src/rt/loadAlertsFromCache.js` |
| TripUpdates merge behavior | `realtime_api/backend/src/merge/applyTripUpdates.js` |
| Swiss platform-vs-parent RT stop-id matching (exact -> `:0` -> numeric root, regex-guarded) | `realtime_api/backend/src/merge/applyTripUpdates.js`, `realtime_api/backend/src/rt/loadScopedRtFromCache.js` |
| Alerts attachment/synthesis | `realtime_api/backend/src/merge/attachAlerts.js`, `realtime_api/backend/src/merge/synthesizeFromAlerts.js` |
| Stop search route behavior | `realtime_api/backend/src/api/stopSearchRoute.js` |
| Stop search normalization/ranking/sql strategy | `realtime_api/backend/src/search/stopsSearch.js`, `realtime_api/backend/src/util/searchNormalize.js` |
| Search DB normalization/index setup | `realtime_api/backend/sql/optimize_stop_search.sql` |
| Stationboard DB optimization SQL | `realtime_api/backend/sql/optimize_stationboard.sql`, `realtime_api/backend/sql/optimize_stationboard_latency.sql` |
| Stationboard RT baseline diagnostics (DB churn + freshness + latency snapshot) | `realtime_api/backend/scripts/rtBaselineReport.mjs`, output `realtime_api/backend/docs/diagnostics/rt-baseline-*.json` and `rt-baseline-*.md` |
| RT cache churn quick measurement (payload sizes/statements/activity) | `realtime_api/backend/scripts/measureRtCacheChurn.mjs`, docs in `realtime_api/backend/README_backend.md` |
| Poll cadence/backoff | `realtime_api/backend/scripts/pollLaTripUpdates.js`, `realtime_api/backend/scripts/pollLaServiceAlerts.js` |
| Frontend polling/render behavior | `realtime_api/frontend/logic.v*.js`, `realtime_api/frontend/ui.v*.js`, `realtime_api/frontend/state.v*.js` |
| Frontend refresh request coalescing (avoid parallel fetch bursts) | `realtime_api/frontend/v20260223-1.main.js` |
| Frontend foreground refresh/resume drift catch-up + unattended-stall rescue + RT fetch diagnostics (`lastFetchAt`, `edgeCache`, `serverFetchedAt`) | `realtime_api/frontend/v20260223-1.main.js`, `realtime_api/frontend/v20260223-1.logic.js`, `realtime_api/frontend/v20260223-1.state.js` |
| Frontend boot / SW update / bfcache reload | `realtime_api/frontend/v20260223-1.main.js` (SW_UPDATED message listener + pageshow persisted listener at end of boot) |
| SW update notification to clients | `realtime_api/frontend/service-worker.js` (activate handler: wasUpdate → postMessage SW_UPDATED) |
| Edge routing/cache/proxy rules | `realtime_api/edge/worker.js`, `realtime_api/edge/wrangler.toml` |

## 7) Common commands (verified)
- `cd realtime_api/backend && npm run dev`
- `cd realtime_api/backend && npm test`
- `cd realtime_api/backend && npm run poller`
- `cd realtime_api/backend && npm run poller:trip`
- `cd realtime_api/backend && npm run poller:alerts`
- `cd realtime_api/backend && npm run search:repro-regression`
- `cd realtime_api/backend && npm run search:verify`
- `cd realtime_api/backend && npm run search:bench`
- `cd realtime_api/backend && node scripts/debugStationboard.js Parent8587387`
- `cd realtime_api/backend && node scripts/rtBaselineReport.mjs --url https://api.mesdeparts.ch --stops Parent8587387,Parent8501000,Parent8501120 --n 30`
- `cd realtime_api/backend && node scripts/measureRtCacheChurn.mjs`
- `cd realtime_api/frontend && npm test`
- `npx wrangler deploy --config realtime_api/edge/wrangler.toml`

## 8) Network/operator detection notes (Swiss specifics)
- `normalizeDeparture()` in `src/models/stationboard.js` is a strict allowlist — any new departure field MUST be explicitly added there or it will be stripped from the API response. This was the root cause of `operatorPatterns` in `network-map.json` never matching: `operator` was not in the allowlist.
- Swiss GTFS route_id format: `{category_code}-{line_number}-{optional_variant}-{feed_version}` (e.g. `92-10-j26-1`). Category codes `91`, `92`, `96` are shared across ALL Swiss operators — NOT operator-specific. Do NOT use bare `^92-` to identify a single operator.
  - Exception: TPN (Transports de la région Nyon–La Côte) uniquely uses 3-digit 800-series line numbers → `^92-8\d{2}` is TPN-specific (lines 803–891).
  - TPG (Geneva), BVB (Basel), VBL (Luzern), Bernmobil (Bern) all use `92-` with low 1–2-digit line numbers.
- Reliable operator detection: use `operatorPatterns` in `network-map.json` matched against `dep.operator` (= `gtfs_agency.agency_name`, e.g. `"Bernmobil"`, `"TPG"`, `"TPN"`) — this works for ANY stop the operator serves, including suburbs not matched by station name.
- `stationPatterns` in `network-map.json` is last-resort fallback (stop name contains "bern" etc.) — fails for suburbs like Köniz, Ostermundigen, Gümligen, Wabern.
- Adding a new operator network: update `config/network-map.json` (operatorPatterns + palette), the inline `DEFAULT_NETWORK_MAP_CONFIG` in `logic.v*.js`, and `style.v*.css` (badge color rules `.line-{prefix}-{line_id}`).

## 9) Documentation maintenance rule
- For behavior changes, update docs in the same PR/commit:
  1. Update the nearest technical README (`backend`, `frontend`, `edge`, `scripts`, `src`).
  2. Update `realtime_api/README_INDEX.md` if navigation or authoritative paths changed.
  3. Update this `AGENTS.md` if runtime entrypoints, ownership, or workflow changed.

## 10) Deployment Configuration (for deployment-related changes)

### Docker Build
- **Root Dockerfile**: `Dockerfile` at repo root
  - Builds the main backend application (`realtime_api/backend/server.js`)
  - References backend source and dependencies with: `COPY realtime_api/backend/...`
  - Do NOT use `realtime_api/backend/Dockerfile` (removed; use root version)
- **Docker ignore**: `.dockerignore` at repo root
  - Excludes unnecessary directories for faster builds: `realtime_api/frontend`, `legacy_api`, `dev-artifacts`, `.claude`
  - Excludes `.env` files and node_modules

### Fly.io Configuration
- **Main app deployment** (`fly.toml` at repo root):
  - App name: `mesdeparts-ch`
  - Dockerfile: `Dockerfile` (points to root)
  - Service: HTTP with port 8080, HTTPS enforced, auto-scaling
  - Deploy: `flyctl deploy` or `fly deploy`
  - Status: https://mesdeparts-ch.fly.dev/

- **Poller service** (`fly.poller.toml` at repo root):
  - Separate Fly.io app for background GTFS-RT polling jobs
  - App name: `mesdeparts-rt-poller`
  - Process: runs `npm run poller` (not HTTP; background task)
  - Deploy: `flyctl deploy --config fly.poller.toml`

### When to Update Deployment Files
| File | Purpose | When to change |
| --- | --- | --- |
| `Dockerfile` | Build main backend app | package.json changes, runtime changes, build optimization |
| `fly.toml` | Deploy main app to Fly.io | resource changes, region changes, health check changes |
| `fly.poller.toml` | Deploy poller service | poller resource/schedule changes |
| `.dockerignore` | Exclude build context files | new build artifacts, faster build optimization |

### Cloudflare Edge Configuration
- **Domain split (authoritative)**:
  - `mesdeparts.ch` → Cloudflare Pages (serves frontend static files; Worker does NOT intercept this domain)
  - `api.mesdeparts.ch` → Cloudflare Worker (`realtime_api/edge/worker.js`) → Fly.io backend
- **Worker config**: `realtime_api/edge/wrangler.toml` — route: `api.mesdeparts.ch/*` only
- **Stationboard caching semantics**:
  - Edge cache: short TTL (`CDN-Cache-Control`, 15 s) in Worker for `/api/stationboard`
  - Browser cache: explicit no-store headers on stationboard JSON (`Cache-Control: private, no-store, max-age=0, must-revalidate`)
- **Deploy Worker**: `npx wrangler deploy --config realtime_api/edge/wrangler.toml`
- **Pages**: managed via Cloudflare dashboard (not in repo); serves `realtime_api/frontend/` static files

### Deployment Troubleshooting
- **"fly.toml not found"**: Ensure `fly.toml` is at repo root (not in subdirectories) and committed to git (`git ls-files fly.toml`)
- **Build context issues**: Check `.dockerignore` doesn't exclude essential files; verify Dockerfile `COPY` paths reference `realtime_api/backend/`
- **Port conflicts**: Backend listens on 8080 (in `Dockerfile` ENV PORT=8080); `fly.toml` routes external port 8080 → internal 8080

## 11) Stop-search change protocol (do not skip)
- Apply changes by risk tier:
  1. aliases/spec data
  2. ranking weights/tie-breakers
  3. SQL retrieval strategy
  4. normalization semantics (JS + SQL together)
- Preserve invariants:
  - degraded fallback path
  - fallback response headers
  - known regression queries
- Mandatory gate before merge/deploy:
  - `node --test test/stopSearch.test.js test/stopSearch.degraded.test.js test/stopSearch.route.test.js`
  - `npm run search:repro-regression`
  - `npm run search:verify`
  - `npm run search:bench`
