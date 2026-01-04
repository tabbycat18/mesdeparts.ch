# GTFS/RT variant

This folder contains the GTFS static + GTFS-RT stack (backend + UI).

- `backend/`: Node/Express service that ingests GTFS static into Postgres and exposes endpoints. Copy `.env.example` to `.env` and fill in credentials/tokens. Install deps with `npm install` from this folder, then run `npm run dev` or `npm start`.
- `data/gtfs-static/`: drop the unpacked GTFS CSV feed here. Files are git-ignored because they exceed GitHub’s size limits.
- `frontend/web-ui-rt/`: static RT UI (versioned assets, no build step). Serve with any static server, e.g. `python3 -m http.server 8001` inside this folder and open `/rt-index.html`.
- `test/`: RT-specific tests mirroring the legacy UI tests.

The legacy simple-API UI remains under `web-ui/` at the repo root; keep the two variants separate.
