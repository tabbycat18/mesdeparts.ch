# AGENTS.md

Living coordination file for this repository.

This file is intentionally lightweight and meant to be updated incrementally.

## Purpose
- Keep project-wide engineering rules in one place.
- Track current architecture decisions.
- Document safe operating procedures for backend/frontend/poller work.

## Current Repo Layout
- `legacy_api/`: legacy stack (static UI + optional Cloudflare Worker).
- `realtime_api/`: active real-time stack (backend + frontend + RT docs).
- `README.md`: top-level orientation.

## Core Rules
- Keep `legacy_api/` and `realtime_api/` changes clearly separated.
- Do not introduce request-path upstream GTFS-RT calls in stationboard APIs.
- Poller remains the upstream fetch point for RT/alerts feeds.
- Keep `/api/stationboard` response contract backward-compatible unless explicitly planned.

## Realtime Backend Guardrails (`realtime_api/backend`)
- Scheduled-first stationboard behavior.
- RT/alerts should degrade safely to scheduled output when cache is missing/stale.
- Prefer bounded processing for protobuf/merge work (avoid unbounded per-request memory growth).
- Add/maintain tests for regression-sensitive logic (merge, route parsing, cache guards).

## Frontend Guardrails (`realtime_api/frontend/web-ui-rt`)
- Preserve no-flicker behavior for RT rendering.
- Do not clear board state on HTTP `204` refresh responses.
- Keep polling/backoff/visibility behavior explicit and testable.

## Legacy Stack Notes (`legacy_api/web-ui`)
- Legacy UI remains supported but separate.
- Avoid coupling legacy behavior to realtime-only internals.

## Standard Validation Commands
- Backend tests:
  - `cd realtime_api/backend && npm test`
- Realtime frontend tests:
  - `cd realtime_api/frontend/web-ui-rt && npm test`
- Legacy frontend tests:
  - `cd legacy_api/web-ui && npm test`

## Deployment Notes (High Level)
- Backend deploy target: Fly.io (`realtime_api/backend`).
- Poller runs separately and writes to shared DB cache.
- CDN/edge behavior should not override API correctness guarantees.

## Open Items / Backlog
- [ ] Keep this file synchronized with major architecture moves.
- [ ] Add explicit env-var matrix (`dev`, `staging`, `prod`).
- [ ] Add incident checklist for RT stale/missing behavior.
- [ ] Add release checklist (backend -> frontend -> poller sequencing).

## Change Log
- 2026-02-22: Initial scaffold created.
