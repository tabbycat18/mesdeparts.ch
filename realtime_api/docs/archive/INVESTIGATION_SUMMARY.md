# Realtime Stack Investigation Summary

## Overview
Comprehensive investigation and fixes for two production issues in the mesdeparts.ch realtime stationboard.

---

## PROBLEM A: Delayed Trains Disappearing ✅ FIXED

### Issue
When a train is delayed, it disappears from the stationboard once its scheduled departure time passes, even though it should remain visible with its realtime departure time.

### Root Cause
**SQL query filters scheduled departures using a 5-minute lookback window** (`PAST_LOOKBACK_MINUTES = 5`). Trains delayed beyond 5 minutes are filtered out by SQL before realtime merge logic runs.

### Solution Implemented
**Increased `PAST_LOOKBACK_MINUTES` from 5 to 60 minutes**

- File: `src/logic/buildStationboard.js:316`
- Change: One-line value update + comments
- Impact: Zero (same query complexity, just wider time window)

### Verification
✅ All 157 tests pass (including 3 new regression tests)
✅ No regressions in existing functionality
✅ Backward compatible via env var override

### Key Changes
1. **File Modified:** `src/logic/buildStationboard.js`
   - Line 316: Changed default from `"5"` to `"60"`
   - Added explanatory comments

2. **Tests Added:** `test/stationboard.delayed-trains.test.js`
   - Test 1: Basic delayed train (scheduled 15 min past, realtime 15 min future)
   - Test 2: Extreme delay (scheduled 60 min past, realtime 75 min delayed)
   - Test 3: Cancelled trains still marked correctly

3. **Documentation Created:**
   - `docs/archive/problem-a/PROBLEM_A_ANALYSIS.md`
   - `docs/archive/problem-a/PROBLEM_A_FIX_SUMMARY.md`
   - `PROBLEM_A_QUICK_REFERENCE.md`

### Deployment Status
🚀 **Ready to deploy immediately**
- Minimal change (1 line)
- Fully tested
- Zero performance impact
- Backward compatible

### How It Works
```
Before: Train scheduled 10:00, delayed to 10:30, at 10:10
  SQL lookback: 10:05 ≤ scheduled ≤ 10:50
  → Train (10:00) < 10:05 → FILTERED OUT

After: Same scenario
  SQL lookback: 09:10 ≤ scheduled ≤ 10:50
  → Train (10:00) is INCLUDED
  → Merge applies realtime (10:30)
  → Final filter uses realtime departure
  → Train STAYS VISIBLE
```

---

## PROBLEM B: Platform Changes Not Showing ✅ INVESTIGATED

### Issue
Cancelled trains show as cancelled in UI, but platform/track changes don't appear in UI.

### Investigation Findings

#### ✅ Backend Implementation Complete
- **Status:** Fully implemented, tested, and working
- **Architecture:** Correct end-to-end
  1. platformByStopId Map built from GTFS stops
  2. applyTripUpdates detects platform changes (when RT stop ≠ scheduled stop)
  3. normalizeDeparture passes through platform + platformChanged fields
  4. Schema includes both fields as optional

#### ✅ Frontend Rendering Complete
- **File:** `ui.v2026-02-21-4.js`
- **Logic:** Shows "Platform1 ↔ Platform2" with arrow when platformChanged=true
- **Styling:** Uses status-delay class for visual highlighting

#### ✅ Test Coverage Complete
- **Test File:** `test/m3.merge.test.js`
- **Status:** Test passes, proving backend works correctly
- **Scenario:**
  - Scheduled at stop "8501120:0:3" (platform "3")
  - Realtime at stop "8501120:0:4" (platform "4")
  - Result: platformChanged=true, platform="4" ✓

#### ❓ Unknown: Why It's Not Working in Production

**Likely Causes (in order of probability):**
1. **GTFS-RT doesn't provide stop_id changes** - RT feed never changes stopId for same trip
2. **GTFS missing platform codes** - stop master data has NULL platform_code
3. **Stop ID format mismatch** - RT uses different format than GTFS
4. **Frontend not updated** - Cached old version without platform rendering

### Investigation Approach

#### Added Debug Instrumentation
1. **applyTripUpdates.js:** Logs when platform change detected
2. **buildStationboard.js:** Logs platformByStopId population
3. Togglable via `DEBUG=1` env var

#### Created Documentation
1. **PROBLEM_B_ANALYSIS.md:** Detailed investigation findings
2. **PROBLEM_B_DEBUG_GUIDE.md:** Comprehensive troubleshooting guide
   - Step-by-step diagnosis flowchart
   - Enable/verify debug output
   - Troubleshooting for each failure scenario
   - Common error messages + solutions
   - Test cases and SQL queries
   - Production monitoring checklist

### Next Steps to Resolve

**Step 1: Verify Debug Output (local)**
```bash
DEBUG=1 npm run dev
curl "http://localhost:3001/api/stationboard?stop_id=...&debug=1"
# Look for: "[buildStationboard] platformByStopId populated"
# Look for: "[applyTripUpdates] Platform change detected"
```

**Step 2: Check GTFS Data**
```bash
psql "$DATABASE_URL" -c "
  SELECT platform_code FROM gtfs_stops
  WHERE platform_code IS NOT NULL LIMIT 5;
"
# Must return results
```

**Step 3: Verify RT Data**
```bash
# Check if RT includes stop_id in TripUpdates
curl "$GTFS_RT_URL" | protoc decode | jq '.entity[0].trip_update.stop_time_update[]' | head
# Should see stop_id field
```

**Step 4: Check Frontend (if backend working)**
```bash
# Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)
# Check dev tools for platform with arrow indicator "3 ↔ 4"
```

### Documentation Structure
```
realtime_api/
├─ docs/
│  └─ archive/
│     └─ problem-a/
│        ├─ PROBLEM_A_ANALYSIS.md
│        └─ PROBLEM_A_FIX_SUMMARY.md
└─ [root]/
   ├─ PROBLEM_B_ANALYSIS.md
   ├─ PROBLEM_B_DEBUG_GUIDE.md
   └─ INVESTIGATION_SUMMARY.md (this file)
```

---

## Code Changes Summary

### Files Modified
| File | Changes | Reason |
|------|---------|--------|
| `src/logic/buildStationboard.js` | PAST_LOOKBACK_MINUTES 5→60 + logging | PROBLEM A fix |
| `src/logic/buildStationboard.js` | Debug logging for platformByStopId | PROBLEM B investigation |
| `src/merge/applyTripUpdates.js` | Debug logging for platform changes | PROBLEM B investigation |

### Files Created
| File | Purpose |
|------|---------|
| `test/stationboard.delayed-trains.test.js` | Regression tests for PROBLEM A |
| `docs/archive/problem-a/PROBLEM_A_ANALYSIS.md` | Root cause analysis |
| `docs/archive/problem-a/PROBLEM_A_FIX_SUMMARY.md` | Fix explanation |
| `PROBLEM_A_QUICK_REFERENCE.md` | Quick lookup guide |
| `PROBLEM_B_ANALYSIS.md` | Investigation findings |
| `PROBLEM_B_DEBUG_GUIDE.md` | Troubleshooting guide |
| `INVESTIGATION_SUMMARY.md` | This document |

### Commits
```
032583b fix: increase PAST_LOOKBACK_MINUTES to 60 to prevent delayed trains from disappearing
668828b feat: add debug instrumentation for PROBLEM B platform changes
```

---

## Testing & Verification

### Test Results
✅ **All 157 tests pass**
- 154 existing tests (all passing)
- 3 new regression tests for PROBLEM A (all passing)
- Platform change test existing and passing

### Test Coverage
- ✅ Delayed train visibility (scheduled past, realtime future)
- ✅ Extreme delays (60+ min)
- ✅ Cancelled trains with past scheduled time
- ✅ Platform change detection
- ✅ Platform change with fallback
- ✅ All other stationboard functionality

---

## Recommendations

### For PROBLEM A (Delayed Trains)
**Status:** ✅ Ready to deploy
1. **Deploy fix immediately** (minimal, safe, tested)
2. **Monitor** for any performance impact (none expected)
3. **Configure** `PAST_LOOKBACK_MINUTES` if needed (optional)

### For PROBLEM B (Platform Changes)
**Status:** ⏳ Awaiting investigation
1. **Enable DEBUG=1** and test with real data
2. **Follow debug guide** to identify root cause
3. **Implement fix** based on root cause:
   - If RT missing stop_id: Add alternative detection (alerts)
   - If GTFS missing platforms: Import/enrich platform data
   - If format mismatch: Add normalization
   - If frontend issue: Force cache clear and redeploy

---

## Additional Resources

### Quick Links
- **PROBLEM A Fix:** `docs/archive/problem-a/PROBLEM_A_FIX_SUMMARY.md`
- **PROBLEM A Reference:** `PROBLEM_A_QUICK_REFERENCE.md`
- **PROBLEM B Analysis:** `PROBLEM_B_ANALYSIS.md`
- **PROBLEM B Debugging:** `PROBLEM_B_DEBUG_GUIDE.md`

### Key Files
- Stationboard Builder: `src/logic/buildStationboard.js`
- Trip Updates Merge: `src/merge/applyTripUpdates.js`
- Stationboard Normalization: `src/models/stationboard.js`
- Frontend Logic: `frontend/logic.v2026-02-21-4.js`
- Frontend Rendering: `frontend/ui.v2026-02-21-4.js`

### Commands
```bash
# Run tests
npm test

# Debug PROBLEM B
DEBUG=1 npm run dev

# Query GTFS data
psql "$DATABASE_URL" -c "SELECT ... FROM gtfs_stops"

# Check RT feed
curl "$GTFS_RT_URL" | protoc decode
```

---

## Summary

| Aspect | PROBLEM A | PROBLEM B |
|--------|-----------|----------|
| **Status** | ✅ FIXED | ⏳ INVESTIGATED |
| **Root Cause Found** | Yes | Probable (data-driven) |
| **Fix Implemented** | Yes | Partial (debug tooling) |
| **Tests Added** | 3 new tests | Existing test passing |
| **Tests Passing** | 157/157 | 157/157 |
| **Ready to Deploy** | Yes | Awaiting investigation |
| **Documentation** | Complete | Complete |
| **Risk Level** | Very Low | Low (debugging) |

---

## Next Actions

### Immediate (Today)
- [x] Fix PROBLEM A (delayed trains disappearing)
- [x] Add regression tests
- [x] Complete all testing
- [x] Commit changes

### Short Term (This Week)
- [ ] Deploy PROBLEM A fix to production
- [ ] Enable DEBUG=1 on staging to investigate PROBLEM B
- [ ] Verify GTFS platform data
- [ ] Check GTFS-RT for stop_id changes

### Medium Term (Next Week)
- [ ] Implement PROBLEM B fix (once root cause identified)
- [ ] Add integration tests for platform changes
- [ ] Update frontend if needed
- [ ] Document final solution

---

## Contact & Questions

For questions about:
- **PROBLEM A fix:** See `PROBLEM_A_QUICK_REFERENCE.md`
- **PROBLEM B investigation:** See `PROBLEM_B_DEBUG_GUIDE.md`
- **General debugging:** See `PROBLEM_B_DEBUG_GUIDE.md` troubleshooting section

All documentation is self-contained and includes examples, SQL queries, and bash commands for verification.
