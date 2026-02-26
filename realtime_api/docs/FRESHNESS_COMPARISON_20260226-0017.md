# Freshness Comparison Report (20260226-0019)

Generated: 2026-02-26T00:19:05.727Z
Window start: 2026-02-26T00:19:05.724Z

## Inputs

- API base: `archived_real_payload_captures`
- Stop ID: `Parent8501120`
- Web samples observed: 4 @ 15.0s target cadence
- Web source: imported web samples (/Users/mattiapastore/Documents/VSC/mesdeparts.ch/realtime_api/docs/diagnostics/freshness/web_samples_real_capture_20260226-0017.json)
- iOS source: imported diagnostics export (/Users/mattiapastore/Documents/VSC/mesdeparts.ch/realtime_api/docs/diagnostics/freshness/ios_export_real_capture_20260226-0017.json)
- iOS samples observed: 4
- iOS expected cadence: 15.0s

## Contract Verdict

- Web vs contract: PASS
- iOS vs contract: PASS
- Combined: PASS

### Web (headless harness)

- Samples: 4
- Meta coverage: 100.0%
- Non-applied rtStatus rate: 0.0%
- rtCacheAgeMs (all) p50/p95: 23463 ms / 23983 ms
- Cadence p50/stddev: 15.00 s / 0.15 s

**rtStatus distribution**
- applied: 4

**responseMode distribution**
- full: 4

| Check | Result | Threshold | Actual |
| --- | --- | --- | --- |
| meta_presence_coverage | PASS | >= 80% samples should contain at least one meta freshness field | 100.0% |
| cadence_not_faster_than_target | PASS | min interval >= 13.8s | 14.90 s |
| applied_rt_cache_p95 | PASS | p95(rtCacheAgeMs where rtStatus=applied) <= 45000 ms | 23983 ms |
| response_mode_known_values | PASS | responseMode in {full,degraded_static,stale_cache_fallback,static_timeout_fallback,not_modified_204} | all known |

Overall: PASS

### iOS (diagnostics export)

- Samples: 4
- Meta coverage: 100.0%
- Non-applied rtStatus rate: 0.0%
- rtCacheAgeMs (all) p50/p95: 23463 ms / 23983 ms
- Cadence p50/stddev: 15.20 s / 0.12 s

**rtStatus distribution**
- applied: 4

**responseMode distribution**
- full: 4

| Check | Result | Threshold | Actual |
| --- | --- | --- | --- |
| meta_presence_coverage | PASS | >= 80% samples should contain at least one meta freshness field | 100.0% |
| cadence_not_faster_than_target | PASS | min interval >= 13.8s | 15.00 s |
| applied_rt_cache_p95 | PASS | p95(rtCacheAgeMs where rtStatus=applied) <= 45000 ms | 23983 ms |
| response_mode_known_values | PASS | responseMode in {full,degraded_static,stale_cache_fallback,static_timeout_fallback,not_modified_204} | all known |

Overall: PASS

## Cross-Client Comparison

- rtCacheAgeMs p95 delta (iOS - web): 0 ms
- non-applied rtStatus rate delta (iOS - web): 0.0%
- cadence stddev delta (iOS - web): -0.04 s

## Interpretation Notes

- Web input used imported captured samples (not collected live in this harness run).
- iOS input used imported diagnostics-export JSON.
- Cadence variance is comparable; no lifecycle-throttling anomaly detected.
- Harness does not use Neon billing counters and only reads stationboard response metadata.

## Backend Change Recommendation

No backend changes required.
