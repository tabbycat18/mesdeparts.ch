# RT Backend Notes

GTFS static datasets must not be committed to git.

Static GTFS is downloaded by CI from the opentransportdata permalink during refresh jobs.
For local legacy tooling, the default folder name has been renamed to `rt/data/gtfs-static-local`.

TODO: remove any remaining legacy static dataset directories after the first successful automated import to Neon.
