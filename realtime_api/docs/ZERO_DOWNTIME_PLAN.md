# Zero-Downtime GTFS Refresh Implementation Plan

## Problem Analysis

### Current Cutover (swap_stage_to_live.sql, lines 7-23)

**Problematic Statements:**
```sql
TRUNCATE TABLE
  public.gtfs_stop_times,
  public.gtfs_calendar_dates,
  public.gtfs_calendar,
  public.gtfs_trips,
  public.gtfs_routes,
  public.gtfs_stops,
  public.gtfs_agency,
  public.app_stop_aliases;

INSERT INTO public.gtfs_agency SELECT * FROM public.gtfs_agency_stage;
INSERT INTO public.gtfs_stops SELECT * FROM public.gtfs_stops_stage;
[... more INSERT statements ...]
```

### Why Downtime Occurs

1. **Empty tables window**: TRUNCATE deletes all rows before INSERTs repopulate them
   - Any query hitting these tables during TRUNCATE gets no results
   - Application search, stop lookup, trip planning all fail

2. **Multiple round-trips**: Even though wrapped in a transaction, the server processes TRUNCATE → INSERT sequentially
   - TRUNCATE deallocates table storage
   - INSERT rebuilds and reindexes
   - Combined operation takes seconds for large tables

3. **app_stop_aliases coupling**: TRUNCATED alongside data tables, losing curated aliases temporarily
   - Restored via backup+FK logic (lines 25-60)
   - But still undergoes empty window

4. **stop_search_index drops immediately** (optimize_stop_search.sql, line 324):
   ```sql
   DROP MATERIALIZED VIEW IF EXISTS public.stop_search_index;
   CREATE MATERIALIZED VIEW public.stop_search_index AS [...]
   ```
   - If application queries stop_search_index during the gap, query planner fails
   - Rebuild from stops/stop_times takes 1-2 seconds on large datasets

### Affected Objects & Impact

| Object | Downtime Effect |
|--------|-----------------|
| gtfs_stops | Stop search returns empty; map cannot resolve stop_id |
| gtfs_stop_times | Trip planner cannot fetch schedules; station board empty |
| gtfs_routes | Route list unavailable; service filtering fails |
| gtfs_trips | Trip lookup fails; booking/confirmation pages broken |
| gtfs_calendar_dates | Exception handling broken; future date queries fail |
| gtfs_agency | Agency metadata missing |
| app_stop_aliases | Manual aliases lost (but restored) |
| stop_search_index | Full-text search for stops fails |

---

## Solution: Atomic Swap Strategy

### Core Principle
Instead of TRUNCATE+INSERT (destructive), use **table renames** (atomic, fast):
- Rename live tables to temporary names
- Rename staged tables to live names
- Drop temps in background

All in a **single brief transaction** = no empty windows.

### Implementation Strategy

#### Phase 1: Build in Shadow (Non-blocking)
- Stage tables already loaded with new data
- Build new stop_search_index with different name (`stop_search_index_new`)
- Create all indexes on new objects
- ✅ Live tables serve normally; no locks

#### Phase 2: Atomic Swap (Minimal Lock)
Inside a **single transaction**:
1. `ALTER TABLE gtfs_agency RENAME TO gtfs_agency_old`
2. `ALTER TABLE gtfs_agency_stage RENAME TO gtfs_agency`
3. (Repeat for all 7 GTFS tables)
4. `ALTER MATERIALIZED VIEW stop_search_index RENAME TO stop_search_index_old`
5. `ALTER MATERIALIZED VIEW stop_search_index_new RENAME TO stop_search_index`
6. Handle `app_stop_aliases` (curated data preservation)
7. COMMIT

**Lock duration:** ~10-50ms (just the renames, no data movement)

#### Phase 3: Cleanup (Background)
After commit:
- `DROP TABLE gtfs_agency_old` (with CASCADE for indexes/constraints)
- `DROP MATERIALIZED VIEW stop_search_index_old`

---

## Detailed Implementation

### New SQL Files

#### 1. `swap_stage_to_live_zero_downtime.sql`
Replaces current `swap_stage_to_live.sql`.

**Strategy:**
- Validate stage tables have data
- Preserve app_stop_aliases data
- Atomic renames inside BEGIN...COMMIT
- Conditional cleanup based on existence

#### 2. `optimize_stop_search_zero_downtime.sql`
Replaces current `optimize_stop_search.sql`.

**Strategy:**
- Build `stop_search_index_new` separately
- Create all indexes with unique names
- Atomic swap (rename old, rename new)
- Drop old asynchronously

---

## Refresh Lifecycle (New)

### Old Flow
```
1. create_stage_tables.sql     → DROP + CREATE stage tables
2. importGtfsToStage.sh        → COPY CSV into stage
3. validate_stage.sql          → Sanity check referential integrity
4. swap_stage_to_live.sql      → ⚠️ TRUNCATE live + INSERT (DOWNTIME)
5. optimize_stop_search.sql    → ⚠️ DROP + CREATE index (DOWNTIME)
```

### New Flow
```
1. create_stage_tables.sql            → DROP + CREATE stage tables
2. importGtfsToStage.sh               → COPY CSV into stage
3. validate_stage.sql                 → Sanity check referential integrity
4. swap_stage_to_live_zero_downtime.sql → Atomic table rename (BRIEF LOCK)
5. optimize_stop_search_zero_downtime.sql → Build new index, atomic swap (BRIEF LOCK)
6. Cleanup (background/async)         → DROP old tables/indexes
```

**Downtime reduction:** From ~5-10 seconds to ~50ms per swap operation

---

## Foreign Key & Constraint Handling

### Current Approach
The old code has a clever FK detection (lines 47-57):
```sql
SELECT a.attname INTO fk_col
FROM pg_constraint c
WHERE ... t.relname = 'app_stop_aliases' AND rt.relname = 'gtfs_stops'
```

**Problem:** After TRUNCATE, app_stop_aliases is empty → restores only aliases with valid FK targets.

### New Approach
1. **No TRUNCATE** → no empty window
2. Before rename: **backup app_stop_aliases** (for safety, optional optimization)
3. After rename: **restore curated aliases** back to the new table
   - Since we're just renaming tables, not dropping them, all FKs stay intact
   - New gtfs_stops is populated → old logic for FK-aware restore still works

**Key insight:** Because the new gtfs_stops is already populated when we rename, the FK validation can proceed normally.

---

## Idempotency & Safety

### Idempotent Design
All operations use **IF EXISTS / IF NOT EXISTS** patterns:
- `DROP TABLE IF EXISTS gtfs_*_old` (safe if prior run crashed)
- `ALTER TABLE ... RENAME TO ... IF EXISTS old table` (safe)
- `CREATE MATERIALIZED VIEW ... IF NOT EXISTS` (safe)

### Transaction Safety
- All renames inside single transaction → all-or-nothing
- If transaction fails, no partial rename; live tables unaffected
- Connection disconnects automatically release advisory locks

### Rollback Friendly
- If something goes wrong mid-transaction, PostgreSQL rolls back all renames
- Live tables revert to their original state (which was serving)

---

## Expected Timeline

### Per GTFS Refresh Cycle
- **Stage load:** ~2-3 seconds (COPY CSV → indexes)
- **Validation:** ~100ms
- **Atomic swap:** ~50ms (brief exclusive lock on metadata; rows untouched)
- **Stop search rebuild:** ~1-2 seconds (FROM clause computed in background)
- **Stop search swap:** ~10ms
- **Metadata update:** ~100ms
- **Cleanup:** ~100ms (DROP)

**Total perceived downtime:** <100ms (imperceptible)
**Previous downtime:** 5-15 seconds

---

## Testing Strategy

1. **Unit test:** Run on replica with old data, verify renames succeed
2. **Dry-run:** Execute swap in transaction, ROLLBACK before cleanup
3. **Staging:** Full refresh on staging environment, monitor query latency
4. **Production:** Monitor with alarms; have rollback procedure ready

---

## Files to Modify

- [x] `realtime_api/backend/sql/swap_stage_to_live.sql` → replace with zero-downtime version
- [x] `realtime_api/backend/sql/optimize_stop_search.sql` → replace with zero-downtime version
- [x] `realtime_api/backend/scripts/refreshGtfsIfNeeded.js` → no changes needed (calls same SQL files)
- [x] Documentation in code comments

---

## Backwards Compatibility

- **Table names:** Unchanged (still `gtfs_stops`, `gtfs_agency`, etc.)
- **View names:** Unchanged (still `stop_search_index`)
- **Column definitions:** Unchanged
- **Indexes:** Unchanged (recreated on new tables, identical names)
- **Foreign keys:** Unchanged (preserved through rename)
- **Application code:** Zero changes required

