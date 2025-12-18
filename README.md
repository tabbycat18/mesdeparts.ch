# mesdeparts.ch

Departure board for Swiss public transport (bus, tram, metro, trains), free and usable straight from a browser.

This project came from personal frustration with paid, closed hardware solutions. It is inspired by:
- the community-made animated SBB clock (see project and Reddit thread below),
- hardware devices like Tramli, while deliberately choosing a different path: **no proprietary hardware, no payment, no signup**.

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

- Animated SBB clock (community project)  
  https://cff-clock.slyc.ch/

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
- Digital clock + embedded SBB clock; auto-refresh every 20 s (~3 h horizon).
- Multilingual UI (FR/DE/IT/EN) and basic network detection (TL/TPG/VBZ/TPN/MBC/VMCV) for line colors.
- Deep links: `?stationName=...&stationId=...` to open a stop directly.

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
- What it does: serverless proxy in front of `transport.opendata.ch`, caches JSON at the edge (20–60 s) so many users share one upstream request per stop.
- Files: `cloudflare-worker/worker.js` (Worker code), `wrangler.toml` (entry + name).
- Deploy (dashboard): Cloudflare → Workers → Create → paste `cloudflare-worker/worker.js` → Deploy → add Custom Domain or Route `api.mesdeparts.ch/*` → let it create the DNS record (proxied/orange cloud).
- Deploy (CLI): `npx wrangler deploy` (uses `wrangler.toml` with `main = cloudflare-worker/worker.js`). If you need a different name/date, adjust `name`/`compatibility_date` in the file.
- Point the UI: add near the top of `web-ui/index.html`:
  ```html
  <script>window.__MD_API_BASE__ = "https://api.mesdeparts.ch";</script>
  ```
  Without this, local/dev falls back to `https://transport.opendata.ch/v1`.
- TTLs: stationboard ~25 s, journey details overlay (`/connections`) ~45 s, locations search 24 h. CORS `*` is set. Errors are not cached.
- Rate limiting: default 120 req/min per IP (set `RATE_LIMIT_PER_MIN` in the Worker env). Optional global daily guard via `GLOBAL_DAILY_LIMIT`.
- Debug headers: `x-md-cache` (HIT/MISS/BYPASS) and `x-md-rate-remaining`.

## How it works
- `index.html` is never cached so it always points to the latest versioned assets.
- JS/CSS assets are versioned (e.g. `main.v2025-12-17.js`) and can be cached for 1 year.
- The UI fetches `/stationboard`, renders the table, and uses the stationboard `passList` directly for details.
- If `passList` is missing, details fall back to `/journey?id=...` and finally `/connections`.
- All API calls go through the Worker (`api.mesdeparts.ch`) to keep upstream load low and predictable.

## Quick structure
- `web-ui/index.html`: board markup, favorites/filters popovers, clocks.
- `web-ui/main.*.js`: app bootstrap, refresh loop, station/URL persistence.
- `web-ui/logic.*.js`: transport.opendata.ch calls + normalization (delays, platforms, modes, filters).
- `web-ui/ui.*.js`: board rendering, stop search, favorites and filters handling.
- `web-ui/state.*.js`: global config (horizons, views, thresholds) and shared state.
- `web-ui/i18n.*.js`: tiny translation helper (FR/DE/IT/EN) + language switch.
- `web-ui/favourites.*.js`: local storage for favorites (`md_favorites_v1`).
- `web-ui/style.*.css`: board styling (modes, network colors, popovers).

## Technical notes
- Default station: `Lausanne, motte`; name and id can be forced via URL or `localStorage`.
- Auto-refresh every 20 s; data depends on API coverage (max 3 h horizon).
- No analytics or backend; all user data (language, favorites) stays in the browser.
