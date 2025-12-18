# mesdeparts.ch

Departure board for Swiss public transport (bus, tram, metro, trains), free and usable straight from a browser.

This project started from wanting a simple, browser-based departure board usable anywhere in Switzerland. It is inspired by:
- the community-made animated SBB clock (see project and Reddit thread below),
- hardware devices like Tramli, with a browser-based approach that **requires no dedicated hardware, no payment, no signup**.

The goal is a simple, open alternative:
- pick any stop or station in Switzerland,
- show departures continuously,
- run it on a laptop, tablet, or small screen without special hardware.

The UI borrows from official boards:
- “bus board” look for buses/trams,
- “train board” look for trains,
kept readable from a distance.

Real-time data comes from transport.opendata.ch.  
Personal project, independent, with no affiliation to transport operators (e.g. SBB/CFF/FFS).

## Inspirations

- Animated SBB clock (self-hosted, Apache 2.0)  
  Source: https://github.com/sbb-design-systems/brand-elements/tree/main/digital-clock  
  Web adaptation inspiration: https://github.com/SlendyMilky/CFF-Clock  
  Demo: https://cff-clock.slyc.ch/

- Reddit thread that sparked the idea  
  https://www.reddit.com/r/Switzerland/comments/1fxt48a/want_a_sbb_clock_on_your_computer/

- Reddit discussion about Tramli.ch  
  https://www.reddit.com/r/Switzerland/comments/1phax17/anyone_has_experience_with_tramlich/

- Tramli (physical departures device)  
  https://tramli.ch/en

## Main features
- Stop search with suggestions and favorite shortcuts (stored in `localStorage`, no account).
- Two bus views: by line (balanced by destination) or chronological; trains are always chronological.
- Quick filters by platform/line + “My favorites” mode to narrow the list.
- Board mode toggle (“Tableau”) for always‑on displays; normal mode for occasional checks.
- Digital clock + self-hosted SBB clock; auto-refresh every 10-20 s depending on mode (~3 h horizon).
- Multilingual UI (FR/DE/IT/EN) and basic network detection (TL/TPG/VBZ/TPN/MBC/VMCV) for line colors.
- Deep links: `?stationName=...&stationId=...` to open a stop directly.
- Installable PWA: manifest + service worker caching the static UI shell (API calls stay online-only).

## Run locally
1) Prerequisite: a recent browser; no build or deps needed. A simple HTTP server avoids ES module issues on `file://`.
2) Start a static server from `web-ui/`:
```sh
cd web-ui
python3 -m http.server 8000
```
3) Open http://localhost:8000 and search for a stop (e.g. "Lausanne, motte").

## Deployment
- The `web-ui/` folder is fully static: drop it on Netlify/Vercel/S3/nginx/Apache as-is.
- `main.*.js` is loaded as an ES module from `index.html`; keep the relative file structure intact.
- Static assets are versioned (`*.vYYYY-MM-DD.js/css`): update filenames and `index.html` references on each release so caches can be long-lived.
- If you deploy via Apache/FTP, upload `web-ui/.htaccess` (hidden file) to set cache headers.

## Edge cache (Cloudflare Worker)
- What it does: serverless proxy in front of `transport.opendata.ch`, caches JSON at the edge (20–60 s) to avoid overloading the public API; many users share one upstream request per stop.
- Files: `cloudflare-worker/worker.js` (Worker code), `wrangler.toml` (entry + name).
- Deploy (dashboard): Cloudflare → Workers → Create → paste `cloudflare-worker/worker.js` → Deploy → add Custom Domain or Route `api.mesdeparts.ch/*` → let it create the DNS record (proxied/orange cloud).
- Deploy (CLI): `npx wrangler deploy` (uses `wrangler.toml` with `main = cloudflare-worker/worker.js`). If you need a different name/date, adjust `name`/`compatibility_date` in the file.
- Point the UI: add near the top of `web-ui/index.html`:
  ```html
  <script>window.__MD_API_BASE__ = "https://api.mesdeparts.ch";</script>
  ```
  Without this, local/dev falls back to `https://transport.opendata.ch/v1`.
- UI toggle: “Tableau” mode (off by default) uses the Worker cache to avoid overloading public servers; normal mode calls `transport.opendata.ch` directly. Refresh cadence is ~20 s in Tableau mode vs ~10 s in normal mode. If the page stays open in normal mode, it auto-switches to Tableau after ~2 minutes unless the user explicitly keeps normal mode.
- TTLs: stationboard ~25 s, journey details overlay (`/connections`) ~45 s, locations search 24 h. CORS `*` is set. Errors are not cached.
- TTL note: the cache TTL applies only in Tableau mode; in normal mode there is no cache, so each UI refresh calls the public API directly.
- Rate limiting: default 120 req/min per IP (set `RATE_LIMIT_PER_MIN` in the Worker env). Optional global daily guard via `GLOBAL_DAILY_LIMIT`.
- Debug headers: `x-md-cache` (HIT/MISS/BYPASS) and `x-md-rate-remaining`.
- How cache affects load: for a given edge + station, the Worker makes at most one upstream call per TTL; users on the same edge share that cached response. Different regions use different edges, so upstream calls scale with edges × stations.
- Limits in practice: the Worker limit is per end-user IP, but the upstream API sees Cloudflare IPs (shared per edge). Cache is what keeps upstream traffic low.
- When it matters: the main board is cached ~25 s and the details overlay ~45 s, so occasional checks only save a little; big savings happen when screens stay open continuously or many users watch the same stop.

## How it works
- `index.html` is never cached so it always points to the latest versioned assets.
- JS/CSS assets are versioned (e.g. `main.v2025-12-18-8.js`) and can be cached for 1 year.
- The UI fetches `/stationboard`, renders the table, and uses the stationboard `passList` directly for details.
- Filters and view changes are applied client‑side from the latest response; they do not trigger extra API calls.
- If `passList` is missing, details fall back to `/journey?id=...` and finally `/connections`.
- API calls go through the Worker (`api.mesdeparts.ch`) when Board mode is on; otherwise the UI calls `transport.opendata.ch` directly.

## Quick structure
- `web-ui/index.html`: board markup, favorites/filters popovers, clocks.
- `web-ui/clock/`: self-hosted SBB clock (sbbUhr).
- `web-ui/main.*.js`: app bootstrap, refresh loop, station/URL persistence.
- `web-ui/logic.*.js`: transport.opendata.ch calls + normalization (delays, platforms, modes, filters).
- `web-ui/ui.*.js`: board rendering, stop search, favorites and filters handling.
- `web-ui/state.*.js`: global config (horizons, views, thresholds) and shared state.
- `web-ui/i18n.*.js`: tiny translation helper (FR/DE/IT/EN) + language switch.
- `web-ui/favourites.*.js`: local storage for favorites (`md_favorites_v1`).
- `web-ui/style.*.css`: board styling (modes, network colors, popovers).

## Technical notes
- Default station: `Lausanne, motte`; name and id can be forced via URL or `localStorage`.
- Auto-refresh every 10-20 s depending on mode; data depends on API coverage (max 3 h horizon).
- No analytics or backend; all user data (language, favorites) stays in the browser.
- Public API limits: transport.opendata.ch is a shared service with rate limits and no SLA; availability and coverage can vary, so consider the Cloudflare Worker cache for steadier performance.

## License
Apache License 2.0. See `LICENSE`.
