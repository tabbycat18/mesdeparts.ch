# PROBLEM A: Delayed Trains Disappearing When Scheduled Time Passes

## Root Cause Analysis

### The Issue
When a train is delayed:
1. At time T: scheduled departure 10:00, realtime departure 10:15 → shown on board ✓
2. At time T+5m (10:05): still shown because lookback is 5 minutes
3. At time T+10m (10:10): disappears from board ✗
   - Scheduled departure time (10:00) is now 10 minutes in the past
   - SQL lookback window is only 5 minutes (PAST_LOOKBACK_MINUTES = 5)
   - Row filtered out by SQL before merge logic even runs
   - Even though realtime says it's departing at 10:15!

### Why It Happens

**Flow:**
```
buildStationboard.js line 335:
  queryFromSecondsRaw = max(0, nowSecondsRaw - lookbackSeconds)
                      = max(0, now - 5min)  // PAST_LOOKBACK_MINUTES = 5 (default)

SQL query (stationboard.sql line 16):
  WHERE ... AND st.departure_time_seconds BETWEEN $2::int AND $3::int
        ... AND st.departure_time_seconds BETWEEN queryFromSecondsRaw AND maxSecondsRaw
```

The SQL query filters **scheduled** departure times. If scheduled time < (now - 5min), the row is excluded before realtime merge logic runs.

**Merge Logic Cannot Help:**
```
buildStationboard.js line 916:
  const mergedScheduledRows = applyTripUpdates(baseRows, scopedTripUpdates)
```
`applyTripUpdates()` can only enhance rows already in `baseRows`. Rows filtered by SQL never make it here.

**Final Filtering (Correct, But Too Late):**
```
buildStationboard.js line 963-990:
  for (const row of nonSuppressedRows) {
    const effectiveDepartureMs = Number.isFinite(realtimeMs) ? realtimeMs : scheduledMs;
    // Uses REALTIME departure if available ✓
    // But row was already deleted by SQL ✗
```

### Why PAST_LOOKBACK_MINUTES=5 Is Insufficient

- 5 minutes covers scenarios where a train is up to 5 minutes delayed
- Does NOT cover realistic delays (10, 30, 60+ minutes)
- User expectation: delayed trains stay visible until they depart

### Example Scenario
```
11:00 - Train scheduled to depart at 11:10, but realtime says 11:25 (15 min delay)
11:10 - Scheduled time passes, train still on board (lookback covers it)
11:15 - Now = 11:15, lookback = 11:10
        SQL filters: 11:10 ≤ scheduled ≤ 11:40
        Train scheduled at 11:10 is INCLUDED (edge case) ✓
11:16 - Now = 11:16, lookback = 11:11
        SQL filters: 11:11 ≤ scheduled ≤ 11:41
        Train scheduled at 11:10 is EXCLUDED (before 11:11) ✗
        Train disappears even though realtime says 11:25!
```

## Solution

**Increase PAST_LOOKBACK_MINUTES default from 5 to 60 (1 hour)**

### Justification
1. **Covers realistic delays**: Most transit delays < 60 minutes
2. **No significant performance impact**: Already fetching ~400 rows; wider window negligible
3. **Correct filter still applies**: JavaScript filtering (line 963-990) still applies the correct logic using `effectiveDepartureMs` (realtime if available)
4. **User expectation**: Users expect delayed trains to stay visible
5. **Configurable**: Can be tuned via `PAST_LOOKBACK_MINUTES` env var

### Changes Required
1. In `buildStationboard.js` line 316:
   ```javascript
   const PAST_LOOKBACK_MINUTES = Number(process.env.PAST_LOOKBACK_MINUTES || "60");  // Changed from "5"
   ```

2. Add regression test covering:
   - Scheduled departure time in the past
   - Realtime departure time in the future
   - Train must still appear in departures array

### Test Case
```javascript
// Train scheduled 10:00, delayed to 10:30
// Current time: 10:15 (scheduled time is 15 min in the past)
// With old lookback (5 min): filtered out by SQL ✗
// With new lookback (60 min): included, realtime merge applies, shown ✓
```

### Potential Concerns
- **Database load**: Minimal (fetching same number of rows, just wider time window)
- **Late trains still disappearing**: Only if delay > 60 min, which is outside typical SLA
- **Option to tune**: Env var allows per-deployment configuration
