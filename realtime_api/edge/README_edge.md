# Edge Worker (Active)

Docs index: [`../README_INDEX.md`](../README_INDEX.md)

This is the active Cloudflare Worker deployment path for `api.mesdeparts.ch/api/*`.

For stationboard diagnostics, the Worker forwards backend `debug=1` payloads
unchanged (including `debug.rt.tripUpdates` fields such as `rtEnabledForRequest`
and `rtMetaReason`).

`/api/stationboard` behavior:
- Uses `caches.default` with normalized cache keys for deterministic edge hits.
- Strips origin anti-cache headers (`Cache-Control: private/no-store`, `Pragma: no-cache`) before caching.
- Caches normalized stationboard responses at the edge with cacheable headers (`Cache-Control: public, max-age=0, s-maxage=15`, `CDN-Cache-Control: public, max-age=15`, `Cloudflare-CDN-Cache-Control: public, max-age=15`).
- Returns browser no-store headers on client responses (`Cache-Control: private, no-store, max-age=0, must-revalidate`, `Pragma: no-cache`) to avoid local stale JSON reuse.

## Files
- `realtime_api/edge/worker.js`: Worker logic.
- `realtime_api/edge/wrangler.toml`: Active Wrangler config used for deploys.

## Deploy
From repo root:

```bash
npx wrangler deploy --config realtime_api/edge/wrangler.toml
```

Or from this folder:

```bash
cd realtime_api/edge
npx wrangler deploy
```

## Legacy Note
- `legacy_api/cloudflare-worker/worker.js` and `legacy_api/wrangler.toml` are archive copies only.
- Do not deploy from `legacy_api`.
