# GTFS/RT UI variant

This folder is the real-time (GTFS static + GTFS-RT) variant of the web UI.

- Keep the legacy “simple API” UI in `web-ui/` separate.
- Deploy this variant from `web-ui-gtfs/` only when you want the GTFS/RT version.
- Keep API keys/configs in a git-ignored local config (e.g., `config.local.js`), not in source control.
- Store any large static slices or RT snapshots under `data/` here and ignore them in git.
