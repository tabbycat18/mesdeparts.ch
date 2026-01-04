# mesdeparts.ch

Live site: https://mesdeparts.ch — this repo hosts the source for GitHub users.

Static Swiss departure board (bus, tram, metro, trains), usable straight from a browser. No account, no install required; designed for laptops, tablets, and small screens.

This started as a simple, browser-based board for any stop in Switzerland—looking like the official boards, but open and hardware-free. It’s a personal project, independent from transport operators (e.g., SBB/CFF/FFS).

## Inspirations
- Animated SBB clock (self-hosted, Apache 2.0)  
  Source: https://github.com/sbb-design-systems/brand-elements/tree/main/digital-clock  
  Web adaptation: https://github.com/SlendyMilky/CFF-Clock  
  Demo: https://cff-clock.slyc.ch/
- Reddit thread that sparked the idea  
  https://www.reddit.com/r/Switzerland/comments/1fxt48a/want_a_sbb_clock_on_your_computer/
- Reddit discussion about Tramli.ch  
  https://www.reddit.com/r/Switzerland/comments/1phax17/anyone_has_experience_with_tramlich/
- Tramli (physical departures device)  
  https://tramli.ch/en

## Main features
- Stop search with suggestions and favorites (stored locally; no account).
- Two bus views: by line (balanced by destination) or chronological; trains are always chronological.
- Filters for platform/line/train service plus “My favorites” mode.
- Board mode toggle (“Tableau”) for always-on displays; direct mode for one-off checks.
- Self-hosted SBB clock + digital clock; auto-refresh every 10–20 s (~3 h horizon).
- Multilingual (FR/DE/IT/EN), deep links via `?stationName=...&stationId=...`, installable PWA shell (API stays online).

## Repo layout
- `web-ui/`: legacy/simple API UI (transport.opendata.ch or your proxy). Full details in `web-ui/README.md`.
- `rt/`: GTFS static + GTFS-RT stack (backend + RT UI). Front-end lives in `rt/frontend/web-ui-rt/` (`rt-index.html`), backend in `rt/backend/` (Express + Postgres). GTFS static CSVs go in `rt/data/gtfs-static/` and are git-ignored.
- `cloudflare-worker/`: optional edge cache/proxy for the simple API UI; not required for FTP/static hosting.

## Run locally
- Legacy UI:
  ```sh
  cd web-ui
  python3 -m http.server 8000
  ```
  Open http://localhost:8000.
- RT UI (static front-end):
  ```sh
  cd rt/frontend/web-ui-rt
  python3 -m http.server 8001
  ```
  Open http://localhost:8001/rt-index.html.
- RT backend:
  ```sh
  cd rt/backend
  cp .env.example .env   # fill in credentials/tokens
  npm install
  npm run dev            # or npm start
  ```

## Deploy
- Upload only the folder you want (`web-ui/` or `rt/frontend/web-ui-rt/`). Skip `cloudflare-worker/` unless you deploy the proxy.
- Assets are versioned; when you bump a JS/CSS file, update the HTML references and the service worker asset list in that folder.

## Optional Cloudflare Worker (simple API UI)
- Proxy in front of `transport.opendata.ch` with short TTLs to reduce upstream calls when many users watch the same stop.
- Files: `cloudflare-worker/worker.js`, `wrangler.toml` (repo root). Point the UI by setting `window.__MD_API_BASE__ = "https://api.mesdeparts.ch"` near the top of `web-ui/index.html`.

## License
Apache License 2.0. See `LICENSE`.
