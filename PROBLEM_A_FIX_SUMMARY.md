# PROBLEM A: Delayed Trains Disappearing - FIX SUMMARY

## Issue
When a train is delayed, it disappears from the stationboard once its **scheduled** departure time passes, even though it should remain visible with its **realtime** departure time.

### Example
- Train scheduled at 10:00, delayed to 10:30
- At 10:05: ✓ visible (within 5-min lookback)
- At 10:10: ✗ disappears (10:00 is 10 min in past, outside 5-min lookback)
- At 10:25: ✗ still gone (even though realtime says 10:30)

## Root Cause
The SQL query filters scheduled departures using a narrow lookback window (5 minutes).

**Code path:**
```
buildStationboard.js:316
  const PAST_LOOKBACK_MINUTES = 5  ← default

buildStationboard.js:335
  const queryFromSecondsRaw = max(0, nowSecondsRaw - lookbackSeconds)  // now - 5 min

src/sql/stationboard.sql:16
  WHERE ... st.departure_time_seconds BETWEEN queryFromSecondsRaw AND maxSecondsRaw
```

If a train is scheduled more than 5 minutes in the past:
1. SQL filters out the row
2. applyTripUpdates() never sees it
3. No realtime merge possible
4. Train disappears

## Solution
**Increase PAST_LOOKBACK_MINUTES from 5 to 60 minutes**

This ensures:
- ✓ Trains with realistic delays (5-60 min) remain in SQL results
- ✓ Realtime merge still applies correctly
- ✓ Final filtering still uses realtime departure time (correct behavior)
- ✓ Configurable via `PAST_LOOKBACK_MINUTES` env var

### Why 60 minutes?
- Covers typical transit delays (most < 60 min)
- No significant performance impact (already fetching ~800 rows)
- Matches user expectations (delayed trains stay visible)
- Still configurable for edge cases

## Changes Made

### 1. Update PAST_LOOKBACK_MINUTES Default
**File:** `realtime_api/backend/src/logic/buildStationboard.js:316`

```javascript
// Before
const PAST_LOOKBACK_MINUTES = Number(process.env.PAST_LOOKBACK_MINUTES || "5");

// After
const PAST_LOOKBACK_MINUTES = Number(process.env.PAST_LOOKBACK_MINUTES || "60");
```

### 2. Add Regression Tests
**File:** `realtime_api/backend/test/stationboard.delayed-trains.test.js` (new)

Three test cases cover:
1. **Basic delayed train:** Scheduled 15 min in past, realtime 15 min in future
2. **Extreme delay:** Scheduled 60 min in past, realtime 15 min in future (75 min total delay)
3. **Cancelled train:** Cancelled trip with past scheduled time still marked correctly

All tests pass with the new 60-minute lookback.

## Verification

```bash
# Run new regression tests
node --test test/stationboard.delayed-trains.test.js
# Output: ✔ 3 tests pass

# Run full test suite
npm test
# Output: ✔ 157 tests pass (includes existing tests)
```

## How It Works (End-to-End)

### Before Fix (5-min lookback)
```
Train: scheduled 10:00, delayed to 10:30
At time 10:10:
  SQL window: 10:05 ≤ scheduled ≤ 10:50
  Train scheduled 10:00 < 10:05 → FILTERED OUT
  Result: ✗ Train disappears
```

### After Fix (60-min lookback)
```
Train: scheduled 10:00, delayed to 10:30
At time 10:10:
  SQL window: 09:10 ≤ scheduled ≤ 10:50
  Train scheduled 10:00 is in range → INCLUDED
  RT merge: applies 30-min delay
  Final filter (buildStationboard.js:963-990):
    effectiveDeparture = realtime (10:30) if available, else scheduled
    msUntil = 10:30 - 10:10 = 20 min → KEPT
  Result: ✓ Train visible with realtime departure 10:30
```

## Configuration

Users can override the default via environment variable:

```bash
# Keep default 60 minutes
# (no action needed)

# Custom value (e.g., 120 minutes for extra safety)
export PAST_LOOKBACK_MINUTES=120

# Minimal lookback for testing
export PAST_LOOKBACK_MINUTES=5
```

## Performance Impact

**Minimal:**
- Wider SQL window doesn't increase query complexity
- Already fetching up to 800 rows; wider time window negligible
- Same number of merge operations (per-row cost unchanged)
- Final filtering unchanged (already filters correctly by realtime time)

## Edge Cases Handled

1. **Cancelled trains:** Still marked cancelled correctly ✓
2. **Extreme delays (>60 min):** May disappear (acceptable, outside SLA)
3. **Early departures:** Still filtered (negative delay clamped to 0) ✓
4. **Previous service day:** Handled correctly (existing logic) ✓
5. **Midnight crossing:** Handled correctly (existing logic) ✓

## Testing Checklist

- ✔ All 157 existing tests pass
- ✔ 3 new regression tests added and passing
- ✔ Merge logic unmodified (safe)
- ✔ Final filtering logic unmodified (safe)
- ✔ SQL structure unmodified (safe)
- ✔ No performance impact expected
