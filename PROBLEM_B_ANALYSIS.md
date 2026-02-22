# PROBLEM B: Train Platform Changes Not Being Shown

## Status
✅ **Backend Implementation Complete** — Platform change detection and emission is fully implemented and tested.
❓ **Production Issue** — May be data-specific or frontend-specific. Investigation needed.

---

## The System (How It Should Work)

### Backend Flow
```
1. buildStationboard.js (line 498-500):
   └─ Build platformByStopId Map from GTFS stop data:
      {
        "8501120:0:3": "3",
        "8501120:0:4": "4"
      }

2. applyTripUpdates.js (line 833-846):
   ├─ When delay match found (RT has stopId):
   │  └─ Compare scheduledStopId vs realtimeStopId
   │     └─ If different:
   │        ├─ Fetch realtimePlatform from platformByStopId
   │        ├─ If platformChanged (realtime ≠ scheduled):
   │        │  ├─ merged.platform = realtimePlatform
   │        │  └─ merged.platformChanged = true
   │        └─ Source: tripupdate
   │
   └─ Result: Departure with:
      {
        "platform": "4",
        "platformChanged": true,
        "_rtMatched": true,
        "source": "tripupdate"
      }

3. stationboard.js (src/models/stationboard.js:329-330):
   └─ normalizeDeparture() normalizes and passes through:
      {
        "platform": "4",
        "platformChanged": true
      }

4. API Response:
   └─ Departure includes platform + platformChanged fields
```

### Frontend Rendering
```
ui.v2026-02-21-4.js:
  ├─ Check: dep.mode === "train" && dep.platformChanged && platformVal
  ├─ If true:
  │  └─ Show: "3 ↔ 4" (with visual styling)
  └─ Else:
     └─ Show: "4" (normal platform)
```

---

## Verification: Backend Is Working ✓

### Test Evidence
**File:** `test/m3.merge.test.js`

```javascript
test("applyTripUpdates marks platformChanged when RT stop_id points to another platform", () => {
  const baseRows = [
    {
      trip_id: "trip-platform-change",
      stop_id: "8501120:0:3",          // Scheduled at platform 3
      platform: "3",
      platformChanged: false,
    },
  ];

  const tripUpdates = {
    entities: [{
      tripUpdate: {
        stopTimeUpdate: [
          {
            stopId: "8501120:0:4",    // Realtime at platform 4
          },
        ],
      },
    }],
  };

  const platformByStopId = new Map([
    ["8501120:0:3", "3"],
    ["8501120:0:4", "4"],
  ]);

  const merged = applyTripUpdates(baseRows, tripUpdates, { platformByStopId });

  // ✅ All assertions pass:
  assert.equal(merged[0].platform, "4");
  assert.equal(merged[0].platformChanged, true);
  assert.equal(merged[0]._rtMatched, true);
});
```

**Result:** ✅ Test passes — Backend functionality works correctly.

---

## Why Platform Changes Might Not Show in Production

### Scenario 1: GTFS-RT Doesn't Include Stop ID Changes
**Most Likely**

If the TripUpdates feed never changes the `stop_id` field between scheduled and realtime:
- applyTripUpdates compares `scheduledStopId` vs `realtimeStopId`
- If always same, the comparison at line 836 (`scheduledStopId !== realtimeStopId`) is false
- No platform change signal is emitted

**How to Verify:**
```bash
# Check actual RT data
curl -s "https://...gtfs-rt-endpoint..." | protoc decode | jq '.entity[].trip_update.stop_time_update[] | {stop_id, departure}'

# Look for: stopId changing between stops? Or same throughout?
# If always same → RT not providing platform changes, backend can't detect
```

### Scenario 2: Platform Not In GTFS Stop Master Data
**Possible**

If the `platformByStopId` Map is empty or doesn't contain the realtime stop:
- Line 837: `platformByStopId.get(realtimeStopId)` returns `undefined`
- Line 838: `if (realtimePlatform !== undefined)` → false, skip platform update

**How to Verify:**
```sql
-- Check if platforms exist in GTFS
SELECT DISTINCT stop_id, platform_code FROM gtfs_stops WHERE platform_code IS NOT NULL LIMIT 20;

-- Check specific stop group
SELECT stop_id, platform_code FROM gtfs_stops WHERE parent_station = '8501120' OR stop_id = '8501120';
```

### Scenario 3: Wrong Stop ID Format in RT vs GTFS
**Possible**

If the stop ID format differs (e.g., `8501120:0:3` in scheduled but `8501120` in realtime):
- Line 836: `scheduledStopId !== realtimeStopId` is true
- Line 837: `platformByStopId.get("8501120")` → undefined or wrong platform
- No update occurs

**How to Verify:**
```javascript
// Add debug logging to applyTripUpdates:
if (scheduledStopId && realtimeStopId && scheduledStopId !== realtimeStopId) {
  console.log({
    scheduledStopId,
    realtimeStopId,
    foundPlatform: platformByStopId.get(realtimeStopId),
  });
}
```

### Scenario 4: RT Data Uses Different Stop ID Variant
**Less Likely**

GTFS-RT might use stop ID variants (with/without platform suffix).
Code already handles this with `stopIdVariants()` function (line 73-86), but only for delay matching.

**Note:** Platform comparison doesn't use variant fallback.

---

## Investigation Checklist

### 1. Verify RT Data Includes Stop ID Changes
```bash
# For a known platform-change case:
curl "http://localhost:3001/api/stationboard?stop_id=...&debug=1" \
  | jq '.debug.rtTripUpdates'

# Check rawTripUpdates or stopTimeUpdates in debug output
# Look for: Different stopId in TripUpdate vs scheduled
```

### 2. Check GTFS Stop Master Data
```sql
SELECT count(*) FROM gtfs_stops WHERE platform_code IS NOT NULL;
-- Should be > 0

SELECT DISTINCT platform_code FROM gtfs_stops LIMIT 10;
-- Should see actual platform codes
```

### 3. Enable Debug Logging
**In applyTripUpdates.js, add after line 837:**

```javascript
if (process.env.DEBUG === "1" && scheduledStopId && realtimeStopId && scheduledStopId !== realtimeStopId) {
  console.log("[PLATFORM_CHANGE]", {
    trip_id: row.trip_id,
    scheduledStopId,
    realtimeStopId,
    realtimePlatform: platformByStopId.get(realtimeStopId),
    allPlatforms: Array.from(platformByStopId.entries()).slice(0, 5),
  });
}
```

### 4. Test with Known Platform Change
Create synthetic trip update with:
- Scheduled: stop `8501120:0:3` (platform "3")
- Realtime: stop `8501120:0:4` (platform "4")
- Verify: `platformChanged` = true in response

---

## Code Locations Reference

| Component | File | Line | Purpose |
|-----------|------|------|---------|
| Platform Map Setup | `src/logic/buildStationboard.js` | 498-500 | Create platformByStopId from GTFS |
| Platform Change Detection | `src/merge/applyTripUpdates.js` | 833-846 | Compare stops, set platformChanged |
| Normalization | `src/models/stationboard.js` | 329-330 | Pass through platform fields |
| Schema | `docs/stationboard.schema.json` | 104-105 | Define platform/platformChanged |
| Frontend Logic | `frontend/logic.v2026-02-21-4.js` | Various | Prepare UI data |
| Frontend Render | `frontend/ui.v2026-02-21-4.js` | "showPlatformChange" | Display with arrow indicator |
| Test | `test/m3.merge.test.js` | Various | Verify backend works |

---

## Key Findings

### What's Implemented
✅ Backend detects platform changes (RT stop ≠ scheduled stop)
✅ Backend emits `platformChanged: true` field
✅ Backend updates `platform` to realtime platform
✅ Schema includes platform + platformChanged
✅ Frontend renders with visual indicator (↔ arrow)
✅ Test suite validates functionality

### What's Unknown
❓ Does real GTFS-RT data include stop_id changes for platform changes?
❓ Are platform codes present in GTFS master data?
❓ Is platformByStopId properly populated with actual stops?

### What's NOT Implemented
- No fallback if RT doesn't provide stop_id
- No alternative platform change detection (e.g., from alert text)
- No historical tracking (what was the previous platform)

---

## Recommended Fix (Conditional)

### If RT Doesn't Provide Stop ID Changes
Implement alternative detection:
1. Watch for same trip/stop but different platform
2. Use route/trip number matching
3. Check alerts for platform change indicators

### If GTFS Missing Platform Data
1. Import/enrich platform codes from external source
2. Assign synthetic platform codes (1, 2, 3, etc.)
3. Document assumption in schema

### If Stop ID Mismatch
1. Normalize stop IDs (strip variant suffixes) for comparison
2. Build bidirectional lookup map
3. Add tolerance for format variations

---

## Next Steps

1. **Verify RT Data:** Check if actual GTFS-RT includes stop_id changes
2. **Check GTFS Data:** Confirm platform_code is populated
3. **Add Logging:** Enable debug output to trace platform detection
4. **Create Integration Test:** With real or realistic RT data
5. **Document Limitations:** If platform changes aren't provided by RT

---

## Summary

**Backend:** Fully implemented, tested, working ✅

**Production Issue:** Likely data-driven (RT/GTFS mismatch)

**Next Action:** Investigate actual data sources
