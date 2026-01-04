# GTFS data (local only)

This folder holds GTFS static data files used by the RT backend. They are git-ignored because the raw CSV exports are large (e.g., `stop_times.csv` is >100 MB and exceeds GitHub’s limit).

Place your downloaded GTFS static feed under `rt/data/gtfs-static/` (same filenames as the official feed). Keep the files local or store them in object storage; do not commit them.
