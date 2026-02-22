# PROBLEM B: Platform Changes - Debug & Troubleshooting Guide

## Quick Diagnosis

Is platform change working? Follow this flowchart:

```
1. Run test query with debug=1
   └─ curl "http://localhost:3001/api/stationboard?stop_id=...&debug=1"

2. Check console output
   ├─ See "[buildStationboard] platformByStopId populated"?
   │  └─ Yes → Go to Step 4
   │  └─ No → GTFS stops might be missing (see Troubleshooting)
   │
   └─ See "[applyTripUpdates] Platform change detected"?
      └─ Yes → Backend working, check frontend rendering
      └─ No → RT data might not include stop_id changes (see Troubleshooting)

3. Check response JSON
   ├─ Look for departure with platformChanged: true?
   │  └─ Yes → Backend working, frontend should display it
   │  └─ No → Platform matching failed (see Troubleshooting)
   │
   └─ Platform field has expected value?
      └─ Yes → Check frontend rendering
      └─ No → Platform mapping issue

4. Check frontend rendering
   └─ Inspect browser dev tools
      └─ Platform cell shows "3 ↔ 4" instead of just "4"?
         └─ Yes → ✅ Everything working!
         └─ No → Frontend rendering issue (see Troubleshooting)
```

---

## Enable Debug Instrumentation

### Server-Side Debugging

**1. Start server with debug enabled:**
```bash
cd realtime_api/backend
DEBUG=1 npm run dev
```

**2. Make stationboard request:**
```bash
curl "http://localhost:3001/api/stationboard?stop_id=8501120&debug=1"
```

**3. Watch console for:**
```
[buildStationboard] platformByStopId populated
├─ count: 5
└─ entries: [["8501120:0:1", "1"], ["8501120:0:2", "2"], ...]

[applyTripUpdates] Platform change detected
├─ trip_id: "162.TA.91-9-K-j26-1.2.H"
├─ scheduledStopId: "8501120:0:1"
├─ realtimeStopId: "8501120:0:2"
├─ prevPlatform: "1"
└─ newPlatform: "2"
```

**4. If NOT seeing these logs:**
- Check if DEBUG=1 is set correctly
- Verify the stationboard is actually processing (check response timestamp)
- Enable stderr capture: `npm run dev 2>&1 | grep -i platform`

### Response-Level Debugging

Check what the backend is actually returning:

```bash
# Get stationboard with debug=1
curl -s "http://localhost:3001/api/stationboard?stop_id=8501120&debug=1" \
  | jq '.departures[] | {trip_id, platform, platformChanged, source, _rtMatched}'

# Should show:
# {
#   "trip_id": "...",
#   "platform": "2",
#   "platformChanged": true,
#   "source": "tripupdate",
#   "_rtMatched": true
# }
```

---

## Troubleshooting Checklist

### ❌ Issue: No platformByStopId entries (count: 0)

**Cause:** GTFS stops table has no platform data

**Diagnosis:**
```bash
# Check if platforms exist in DB
psql "$DATABASE_URL" -c "
  SELECT count(*) as total,
         sum(case when platform_code IS NOT NULL then 1 else 0 end) as with_platforms
  FROM gtfs_stops;
"
# Expected: with_platforms > 0
```

**Fix:**
```sql
-- Option 1: Verify data import completed correctly
SELECT parent_station, stop_id, platform_code
FROM gtfs_stops
WHERE parent_station = '8501120' OR stop_id = '8501120';

-- Option 2: Manually add platform data if missing
UPDATE gtfs_stops
SET platform_code =
  CASE
    WHEN stop_id LIKE '%:0:1' THEN '1'
    WHEN stop_id LIKE '%:0:2' THEN '2'
    WHEN stop_id LIKE '%:0:3' THEN '3'
    WHEN stop_id LIKE '%:0:4' THEN '4'
  END
WHERE platform_code IS NULL;
```

---

### ❌ Issue: Platform entries exist, but no platform changes detected

**Cause:** GTFS-RT data doesn't include stop_id changes

**Diagnosis:**
```bash
# Decode actual RT feed
curl -s "https://...gtfs-rt-endpoint..." | \
  protoc decode --type=transit_realtime.FeedMessage | \
  jq '.entity[].trip_update.stop_time_update[] | {stop_id, departure}' | head -20

# Look for: Does stop_id change for same trip at different stops?
# Expected: Yes, different stop_ids for different stops
# Problem: If all same or if stop_id missing
```

**Fix Options:**

Option A: Use alternative platform detection (alerts, text parsing)
```javascript
// In applyTripUpdates.js, fallback when RT stop_id not provided:
if (!realtimeStopId && alerts.length > 0) {
  // Parse alert text for "platform" or "track" mentions
  const platformMatch = alert.description?.match(/platform\s+(\d+)/i);
  if (platformMatch) {
    merged.platform = platformMatch[1];
    merged.platformChanged = true;
  }
}
```

Option B: Check if upstream RT feed supports platform changes
```bash
# Contact data provider, ask:
# "Does your GTFS-RT include stop_id changes for platform reassignments?"
# "Or do you provide platform info in service alerts?"
```

---

### ❌ Issue: Platform changes detected but not rendering in UI

**Cause:** Frontend not getting the field, or CSS not styling it

**Diagnosis:**

1. **Check response includes the field:**
```bash
curl -s "http://localhost:3001/api/stationboard?stop_id=..." | \
  jq '.departures[] | select(.platformChanged == true)'
# Should return departures with platformChanged: true
```

2. **Check frontend receives it:**
```javascript
// In browser console:
fetch('http://localhost:3001/api/stationboard?stop_id=...').then(r=>r.json()).then(d=>{
  d.departures.filter(dep => dep.platformChanged).forEach(dep => {
    console.log({trip_id: dep.trip_id, platform: dep.platform, platformChanged: dep.platformChanged});
  });
});
```

3. **Check HTML rendering:**
```javascript
// In browser console, after page loads:
document.querySelectorAll('.col-platform-cell').forEach((el, i) => {
  if (i < 3) console.log(el.textContent, el.className);
});
// Should see:
// "3" with class="col-platform-cell"
// "3 ↔ 4" with class="col-platform-cell status-delay"
```

**Fix:**

If response has `platformChanged: true` but not rendering:

1. Check frontend version is recent (should be v2026-02-21-4 or later):
```bash
ls -la realtime_api/frontend/ui.v*.js | tail -1
```

2. Verify UI logic includes platform change rendering:
```bash
grep -n "showPlatformChange\|platformChanged" realtime_api/frontend/ui.v*.js | head -5
```

3. Check browser actually loaded new version:
```javascript
// In browser DevTools:
// - Check Network tab for ui.v*.js
// - Check "Disable cache" is checked
// - Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
```

4. Check CSS exists for styling:
```bash
grep -r "status-delay\|platform-badge" realtime_api/frontend/
# Should find CSS rules for these classes
```

---

### ❌ Issue: Wrong platform showing (not the realtime platform)

**Cause:** Platform mapping is incorrect or RT stop_id not matching GTFS

**Diagnosis:**
```bash
# Manually check the mapping
DEBUG=1 npm run dev

# In another terminal:
curl "http://localhost:3001/api/stationboard?stop_id=8501120&debug=1" 2>&1 | grep platformByStopId

# Should show exact mapping
```

**Verification:**
```bash
# Check if RT stop IDs exist in GTFS
psql "$DATABASE_URL" -c "
  SELECT stop_id, platform_code FROM gtfs_stops
  WHERE stop_id IN ('8501120:0:1', '8501120:0:2', '8501120:0:3', '8501120:0:4');
"
# All should have results
```

**Fix:**

If some RT stop IDs not in GTFS:
```sql
-- Find all variants for a station
SELECT DISTINCT stop_id FROM gtfs_stops
WHERE parent_station = '8501120' OR stop_id LIKE '8501120%';

-- Add missing ones with correct platform codes
INSERT INTO gtfs_stops (stop_id, stop_name, parent_station, platform_code)
VALUES ('8501120:0:5', 'Lausanne Platform 5', '8501120', '5');
```

---

## Test Cases

### Test 1: Platform Change with Real RT Data

```bash
# Setup
DEBUG=1 npm run dev

# In another terminal, monitor logs
tail -f /tmp/debug.log &

# Make request
curl "http://localhost:3001/api/stationboard?stop_id=8501120&limit=50&debug=1" > response.json

# Verify
jq '.departures[] | select(.platformChanged == true)' response.json
```

### Test 2: Platform Change with Synthetic Data

```javascript
// File: test/stationboard.platform-change.test.js
import { applyTripUpdates } from "../src/merge/applyTripUpdates.js";

test("platform change detection works", () => {
  const baseRows = [{
    trip_id: "test-trip",
    stop_id: "8501120:0:1",  // Scheduled at platform 1
    platform: "1",
    scheduledDeparture: "2026-02-22T10:00:00Z",
  }];

  const tripUpdates = {
    entities: [{
      tripUpdate: {
        trip: { tripId: "test-trip" },
        stopTimeUpdate: [{
          stopId: "8501120:0:3",  // Realtime at platform 3
        }],
      },
    }],
  };

  const platformByStopId = new Map([
    ["8501120:0:1", "1"],
    ["8501120:0:3", "3"],
  ]);

  const result = applyTripUpdates(baseRows, tripUpdates, { platformByStopId });

  assert.equal(result[0].platform, "3");
  assert.equal(result[0].platformChanged, true);
});
```

---

## Common Error Messages & Solutions

| Error/Issue | Cause | Solution |
|------------|-------|----------|
| `platformByStopId` empty | No platform data in GTFS | Import platforms or add manually |
| `realtimePlatform` undefined | RT stop_id not in platformByStopId | Check stop_id format, add to GTFS |
| `platformChanged` always false | RT not providing stop_id changes | Check RT feed, use alerts fallback |
| UI shows platform but no arrow | Frontend not updated | Reload page with Ctrl+Shift+R |
| Console has no debug output | `DEBUG=1` not set | Set env var and restart server |
| Wrong platform number | Mapping mismatch | Verify GTFS stop_id ↔ platform_code mapping |

---

## Production Deployment

### Before Deploying

1. **Verify GTFS platform data:**
```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM gtfs_stops WHERE platform_code IS NOT NULL;"
# Should be > 0
```

2. **Verify GTFS-RT includes stop_id in TripUpdates:**
```bash
# Check sample of RT feed
curl -s "$GTFS_RT_URL" | protoc decode | jq '.entity[].trip_update.stop_time_update[0] | keys'
# Should see: ["stop_id", "stop_sequence", "departure", ...]
```

3. **Run test suite:**
```bash
npm test
# All 157 tests should pass
```

### Monitoring Post-Deployment

**Watch for:**
```bash
# Platform changes being detected (if DEBUG=1):
grep "Platform change detected" server.log | wc -l
# Should be > 0 if platform changes occur

# No errors in merge logic:
grep "ERROR.*platformByStopId\|ERROR.*platform" server.log
# Should be empty
```

---

## Advanced Debugging

### Add Detailed Tracing

**In applyTripUpdates.js, replace debug log:**
```javascript
if (process.env.DEBUG === "1") {
  const trace = {
    trip_id: row.trip_id,
    scheduledStopId,
    realtimeStopId,
    compareResult: scheduledStopId !== realtimeStopId,
    platformByStopIdSize: platformByStopId.size,
    realtimePlatformLookup: platformByStopId.get(realtimeStopId),
    mapSnapshot: Array.from(platformByStopId.entries()).filter(([k]) =>
      k.includes(String(realtimeStopId).split(':')[0])
    ),
  };
  console.log("[PLATFORM_TRACE]", trace);
}
```

### Database Audit

```sql
-- Show all stops with platforms
SELECT
  parent_station,
  stop_id,
  stop_name,
  platform_code,
  CASE WHEN platform_code IS NULL THEN 'MISSING' ELSE 'OK' END as status
FROM gtfs_stops
WHERE parent_station = '8501120'
ORDER BY stop_id;
```

### RT Feed Inspection

```bash
# Decode and inspect RT entities
curl -s "$GTFS_RT_URL" | \
  protoc decode --type=transit_realtime.FeedMessage | \
  jq '.entity[0:5] | map({
    trip_id: .trip_update.trip.trip_id,
    updates: .trip_update.stop_time_update[0:2] | map(.stop_id)
  })'

# Look for pattern: Are stop_ids changing across updates for same trip?
```

---

## Summary

| Scenario | Steps | Success Indicator |
|----------|-------|-------------------|
| Verify backend works | Run test, check console | `[applyTripUpdates] Platform change detected` |
| Verify RT data includes stop_id | Inspect RT feed | stop_id varies across stop_time_updates |
| Verify GTFS has platform data | Query database | Rows with non-null platform_code |
| Verify frontend renders | Check UI | "Platform1 ↔ Platform2" with arrow |
| Debug a specific trip | Use DEBUG=1 and jq | Trace shows matched platform and reason |

For each scenario, follow the checklist and look for the success indicator. If not found, check the troubleshooting section for your scenario.
