-- Forgiving stop search setup (idempotent).
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stop_search.sql

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[stop-search] pg_trgm extension not available (insufficient_privilege)';
    WHEN OTHERS THEN
      RAISE NOTICE '[stop-search] pg_trgm extension not available: %', SQLERRM;
  END;

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS unaccent';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[stop-search] unaccent extension not available (insufficient_privilege)';
    WHEN OTHERS THEN
      RAISE NOTICE '[stop-search] unaccent extension not available: %', SQLERRM;
  END;
END
$$;

CREATE OR REPLACE FUNCTION public.md_unaccent(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
BEGIN
  BEGIN
    RETURN public.unaccent('unaccent'::regdictionary, input);
  EXCEPTION
    WHEN undefined_function THEN
      RETURN input;
    WHEN invalid_parameter_value THEN
      RETURN input;
    WHEN OTHERS THEN
      RETURN input;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_stop_search_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              translate(
                lower(public.md_unaccent(input)),
                'àáâãäåçèéêëìíîïñòóôõöøùúûüýÿ',
                'aaaaaaceeeeiiiinoooooouuuuyy'
              ),
              '[-_./''’`]+',
              ' ',
              'g'
            ),
            '[^[:alnum:][:space:]]+',
            ' ',
            'g'
          ),
          '\m(st|saint)\M',
          'saint',
          'g'
        ),
        '\m(hauptbahnhof|hbf|hb)\M',
        'hb',
        'g'
      ),
      '\s+',
      ' ',
      'g'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.strip_stop_search_terms(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT trim(
    regexp_replace(
      regexp_replace(
        COALESCE(public.normalize_stop_search_text(input), ''),
        '\m(gare|bahnhof|station|stazione)\M',
        ' ',
        'gi'
      ),
      '\s+',
      ' ',
      'g'
    )
  );
$$;

DO $$
BEGIN
  IF to_regclass('public.stop_aliases') IS NULL THEN
    CREATE TABLE public.stop_aliases (
      alias_text TEXT PRIMARY KEY,
      alias_norm TEXT,
      stop_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      canonical_key TEXT,
      source TEXT NOT NULL DEFAULT 'seed',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'alias'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'alias_text'
  ) THEN
    ALTER TABLE public.stop_aliases RENAME COLUMN alias TO alias_text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'target_stop_id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'stop_id'
  ) THEN
    ALTER TABLE public.stop_aliases RENAME COLUMN target_stop_id TO stop_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'alias_norm'
  ) THEN
    ALTER TABLE public.stop_aliases ADD COLUMN alias_norm TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'canonical_key'
  ) THEN
    ALTER TABLE public.stop_aliases ADD COLUMN canonical_key TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'source'
  ) THEN
    ALTER TABLE public.stop_aliases ADD COLUMN source TEXT NOT NULL DEFAULT 'seed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stop_aliases'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.stop_aliases ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END
$$;

UPDATE public.stop_aliases
SET
  alias_norm = public.normalize_stop_search_text(alias_text),
  updated_at = NOW()
WHERE
  alias_norm IS NULL
  OR alias_norm = ''
  OR alias_norm <> public.normalize_stop_search_text(alias_text);

ALTER TABLE public.stop_aliases
  ALTER COLUMN alias_norm SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stop_aliases_alias_text_unique
ON public.stop_aliases (alias_text);

CREATE INDEX IF NOT EXISTS idx_stop_aliases_stop_id
ON public.stop_aliases (stop_id);

CREATE INDEX IF NOT EXISTS idx_stop_aliases_alias_norm_prefix
ON public.stop_aliases (alias_norm text_pattern_ops);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_stop_aliases_alias_norm_trgm ON public.stop_aliases USING GIN (alias_norm gin_trgm_ops)';
  ELSE
    RAISE NOTICE '[stop-search] skip idx_stop_aliases_alias_norm_trgm (pg_trgm unavailable)';
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.app_stop_aliases') IS NOT NULL THEN
    INSERT INTO public.stop_aliases (
      alias_text,
      alias_norm,
      stop_id,
      weight,
      canonical_key,
      source,
      updated_at
    )
    SELECT
      a.alias,
      public.normalize_stop_search_text(a.alias),
      a.stop_id,
      1.20::real,
      NULL,
      'app_alias',
      NOW()
    FROM public.app_stop_aliases a
    WHERE COALESCE(a.alias, '') <> ''
      AND COALESCE(a.stop_id, '') <> ''
    ON CONFLICT (alias_text)
    DO UPDATE SET
      alias_norm = EXCLUDED.alias_norm,
      stop_id = EXCLUDED.stop_id,
      weight = GREATEST(public.stop_aliases.weight, EXCLUDED.weight),
      source = CASE
        WHEN public.stop_aliases.source = 'seed' THEN public.stop_aliases.source
        ELSE EXCLUDED.source
      END,
      updated_at = NOW();
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.stop_alias_seed_specs (
  canonical_key TEXT NOT NULL,
  target_name TEXT NOT NULL,
  alias_text TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (canonical_key, alias_text)
);

WITH seed_specs(canonical_key, target_name, alias_text, weight, active) AS (
  VALUES
    ('zurich_hb', 'Zürich HB', 'zurich', 9.50::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'zuerich', 9.50::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'zurich hb', 9.80::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'zuerich hb', 9.80::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'zurich hbf', 9.40::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'zuerich hbf', 9.40::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'hb', 8.50::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'hbf', 8.40::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'hauptbahnhof', 8.80::real, TRUE),
    ('zurich_hb', 'Zürich HB', 'hauptbahnhof zurich', 9.20::real, TRUE),

    ('geneve_cornavin', 'Genève, gare Cornavin', 'cornavin', 9.80::real, TRUE),
    ('geneve_cornavin', 'Genève, gare Cornavin', 'cornavain', 8.60::real, TRUE),
    ('geneve_cornavin', 'Genève, gare Cornavin', 'gare cornavin', 9.70::real, TRUE),
    ('geneve_cornavin', 'Genève, gare Cornavin', 'geneve cornavin', 9.50::real, TRUE),
    ('geneve_cornavin', 'Genève, gare Cornavin', 'genf cornavin', 9.20::real, TRUE),
    ('geneve_cornavin', 'Genève, gare Cornavin', 'geneva cornavin', 9.00::real, TRUE),

    ('st_gallen', 'St. Gallen', 'st gallen', 9.50::real, TRUE),
    ('st_gallen', 'St. Gallen', 'st. gallen', 9.50::real, TRUE),
    ('st_gallen', 'St. Gallen', 'saint gallen', 8.80::real, TRUE),

    ('geneve_bel_air', 'Genève, Bel-Air', 'bel air', 8.80::real, TRUE),
    ('geneve_bel_air', 'Genève, Bel-Air', 'bel-air', 8.80::real, TRUE),
    ('geneve_bel_air', 'Genève, Bel-Air', 'geneve bel air', 8.50::real, TRUE),
    ('geneve_bel_air', 'Genève, Bel-Air', 'geneve bel-air', 8.50::real, TRUE),

    ('geneve_main', 'Genève', 'geneve', 8.80::real, TRUE),
    ('geneve_main', 'Genève', 'genève', 8.80::real, TRUE)
)
INSERT INTO public.stop_alias_seed_specs (canonical_key, target_name, alias_text, weight, active)
SELECT
  s.canonical_key,
  s.target_name,
  s.alias_text,
  s.weight,
  s.active
FROM seed_specs s
ON CONFLICT (canonical_key, alias_text)
DO UPDATE SET
  target_name = EXCLUDED.target_name,
  weight = EXCLUDED.weight,
  active = EXCLUDED.active;

-- ===========================================================================================
-- ZERO-DOWNTIME STOP SEARCH INDEX REBUILD: Atomic Materialized View Swap
-- ===========================================================================================
-- Strategy: Build new index with different name, swap atomically into place
--
-- 1. Build stop_search_index_new (non-blocking, old index still serves)
-- 2. Create indexes on _new version
-- 3. Atomic swap:
--    a. Rename old → _old (if exists)
--    b. Rename _new → live name
-- 4. Drop _old in same transaction
-- 5. ANALYZE for query planner
--
-- Lock duration: ~10-50ms (just metadata updates, no data movement)
-- Downtime: <100ms (vs 1-2 seconds with old DROP+CREATE)
-- ===========================================================================================

BEGIN;

\echo '[stop-search] Normalizing legacy stop_search_index index names...'

DO $$
DECLARE
  live_rel_oid OID;
  row_rec RECORD;
  legacy_idx_oid OID;
  legacy_idx_rel_oid OID;
  canonical_idx_oid OID;
  canonical_idx_rel_oid OID;
BEGIN
  SELECT c.oid
  INTO live_rel_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'stop_search_index'
    AND c.relkind = 'm';

  IF live_rel_oid IS NULL THEN
    RAISE NOTICE '[stop-search] stop_search_index does not exist yet; skip legacy index normalization';
    RETURN;
  END IF;

  FOR row_rec IN
    SELECT *
    FROM (
      VALUES
        ('idx_stop_search_index_new_stop_id', 'idx_stop_search_index_stop_id'),
        ('idx_stop_search_index_new_group_id', 'idx_stop_search_index_group_id'),
        ('idx_stop_search_index_new_is_parent', 'idx_stop_search_index_is_parent'),
        ('idx_stop_search_index_new_name_norm_prefix', 'idx_stop_search_index_name_norm_prefix'),
        ('idx_stop_search_index_new_search_text_trgm', 'idx_stop_search_index_search_text_trgm'),
        ('idx_stop_search_index_new_name_norm_trgm', 'idx_stop_search_index_name_norm_trgm'),
        ('idx_stop_search_index_new_name_core_trgm', 'idx_stop_search_index_name_core_trgm'),
        ('idx_stop_search_index_new_parent_name_norm_trgm', 'idx_stop_search_index_parent_name_norm_trgm')
    ) AS idx_map(new_name, canonical_name)
  LOOP
    SELECT c.oid, i.indrelid
    INTO legacy_idx_oid, legacy_idx_rel_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.new_name;

    IF legacy_idx_oid IS NULL THEN
      CONTINUE;
    END IF;

    IF legacy_idx_rel_oid IS DISTINCT FROM live_rel_oid THEN
      RAISE NOTICE '[stop-search] dropping stale legacy index % (not on stop_search_index)', row_rec.new_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.new_name);
      CONTINUE;
    END IF;

    SELECT c.oid, i.indrelid
    INTO canonical_idx_oid, canonical_idx_rel_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.canonical_name;

    IF canonical_idx_oid IS NULL THEN
      RAISE NOTICE '[stop-search] renaming legacy index % -> %', row_rec.new_name, row_rec.canonical_name;
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', row_rec.new_name, row_rec.canonical_name);
    ELSIF canonical_idx_rel_oid = live_rel_oid THEN
      RAISE NOTICE '[stop-search] dropping duplicate legacy index % (canonical % already exists)', row_rec.new_name, row_rec.canonical_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.new_name);
    ELSE
      RAISE NOTICE '[stop-search] dropping stale canonical index % (belongs to another relation)', row_rec.canonical_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.canonical_name);
      RAISE NOTICE '[stop-search] renaming legacy index % -> %', row_rec.new_name, row_rec.canonical_name;
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', row_rec.new_name, row_rec.canonical_name);
    END IF;
  END LOOP;
END
$$;

\echo '[stop-search] Building stop_search_index_new (non-blocking)...'

-- Build the new index with same structure
-- Use _new suffix to avoid conflicts with live index
DROP MATERIALIZED VIEW IF EXISTS public.stop_search_index_new;

CREATE MATERIALIZED VIEW public.stop_search_index_new AS
WITH stop_counts AS (
  SELECT
    st.stop_id,
    COUNT(*)::int AS stop_dep_count
  FROM public.gtfs_stop_times st
  GROUP BY st.stop_id
),
station_groups AS (
  SELECT
    COALESCE(NULLIF(s.parent_station, ''), s.stop_id) AS group_id,
    MAX(
      CASE
        WHEN NULLIF(s.parent_station, '') IS NULL OR s.stop_id LIKE 'Parent%'
        THEN s.stop_name
        ELSE NULL
      END
    ) AS parent_name,
    MIN(s.stop_name) AS fallback_name
  FROM public.gtfs_stops s
  GROUP BY 1
),
group_counts AS (
  SELECT
    COALESCE(NULLIF(s.parent_station, ''), s.stop_id) AS group_id,
    SUM(COALESCE(sc.stop_dep_count, 0))::int AS group_dep_count
  FROM public.gtfs_stops s
  LEFT JOIN stop_counts sc ON sc.stop_id = s.stop_id
  GROUP BY 1
)
SELECT
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  public.normalize_stop_search_text(s.stop_name) AS name_norm,
  public.strip_stop_search_terms(public.normalize_stop_search_text(s.stop_name)) AS name_core,
  public.normalize_stop_search_text(COALESCE(NULLIF(sg.parent_name, ''), sg.fallback_name, trim(split_part(s.stop_name, ',', 1)))) AS parent_name_norm,
  trim(
    concat_ws(
      ' ',
      public.normalize_stop_search_text(s.stop_name),
      public.strip_stop_search_terms(public.normalize_stop_search_text(s.stop_name)),
      public.normalize_stop_search_text(COALESCE(NULLIF(sg.parent_name, ''), sg.fallback_name, trim(split_part(s.stop_name, ',', 1))))
    )
  ) AS search_text,
  (
    NULLIF(to_jsonb(s) ->> 'parent_station', '') IS NULL
    OR COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') = '1'
    OR s.stop_id LIKE 'Parent%'
  ) AS is_parent,
  (public.normalize_stop_search_text(s.stop_name) ~ '(^| )(hb|hbf|hauptbahnhof)( |$)') AS has_hub_token,
  COALESCE(sc.stop_dep_count, 0)::int AS stop_nb_stop_times,
  COALESCE(gc.group_dep_count, 0)::int AS nb_stop_times
FROM public.gtfs_stops s
LEFT JOIN stop_counts sc ON sc.stop_id = s.stop_id
LEFT JOIN station_groups sg ON sg.group_id = COALESCE(NULLIF(s.parent_station, ''), s.stop_id)
LEFT JOIN group_counts gc ON gc.group_id = COALESCE(NULLIF(s.parent_station, ''), s.stop_id)
WITH DATA;

\echo '[stop-search] Built stop_search_index_new'

-- Create indexes on the new materialized view
\echo '[stop-search] Creating indexes on stop_search_index_new...'

DO $$
DECLARE
  mv_oid OID;
  row_rec RECORD;
  idx_oid OID;
  idx_rel_oid OID;
  idx_is_valid BOOLEAN;
  has_pg_trgm BOOLEAN;
  should_create BOOLEAN;
BEGIN
  SELECT c.oid
  INTO mv_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'stop_search_index_new'
    AND c.relkind = 'm';

  IF mv_oid IS NULL THEN
    RAISE EXCEPTION '[stop-search] stop_search_index_new does not exist before index creation';
  END IF;

  FOR row_rec IN
    SELECT *
    FROM (
      VALUES
        ('idx_stop_search_index_new_stop_id', 'CREATE UNIQUE INDEX idx_stop_search_index_new_stop_id ON public.stop_search_index_new (stop_id)'),
        ('idx_stop_search_index_new_group_id', 'CREATE INDEX idx_stop_search_index_new_group_id ON public.stop_search_index_new (group_id)'),
        ('idx_stop_search_index_new_is_parent', 'CREATE INDEX idx_stop_search_index_new_is_parent ON public.stop_search_index_new (is_parent)'),
        ('idx_stop_search_index_new_name_norm_prefix', 'CREATE INDEX idx_stop_search_index_new_name_norm_prefix ON public.stop_search_index_new (name_norm text_pattern_ops)')
    ) AS idx_map(idx_name, create_sql)
  LOOP
    should_create := FALSE;

    SELECT c.oid, i.indrelid, i.indisvalid
    INTO idx_oid, idx_rel_oid, idx_is_valid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.idx_name;

    IF idx_oid IS NOT NULL THEN
      IF idx_rel_oid = mv_oid AND idx_is_valid THEN
        RAISE NOTICE '[stop-search] keeping existing index % on stop_search_index_new', row_rec.idx_name;
      ELSE
        RAISE NOTICE '[stop-search] dropping stale index % before recreate', row_rec.idx_name;
        EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.idx_name);
        should_create := TRUE;
      END IF;
    ELSE
      should_create := TRUE;
    END IF;

    IF should_create THEN
      RAISE NOTICE '[stop-search] creating index % on stop_search_index_new', row_rec.idx_name;
      EXECUTE row_rec.create_sql;
    END IF;
  END LOOP;

  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
  INTO has_pg_trgm;

  IF has_pg_trgm THEN
    FOR row_rec IN
      SELECT *
      FROM (
        VALUES
          ('idx_stop_search_index_new_search_text_trgm', 'CREATE INDEX idx_stop_search_index_new_search_text_trgm ON public.stop_search_index_new USING GIN (search_text gin_trgm_ops)'),
          ('idx_stop_search_index_new_name_norm_trgm', 'CREATE INDEX idx_stop_search_index_new_name_norm_trgm ON public.stop_search_index_new USING GIN (name_norm gin_trgm_ops)'),
          ('idx_stop_search_index_new_name_core_trgm', 'CREATE INDEX idx_stop_search_index_new_name_core_trgm ON public.stop_search_index_new USING GIN (name_core gin_trgm_ops)'),
          ('idx_stop_search_index_new_parent_name_norm_trgm', 'CREATE INDEX idx_stop_search_index_new_parent_name_norm_trgm ON public.stop_search_index_new USING GIN (parent_name_norm gin_trgm_ops)')
      ) AS idx_map(idx_name, create_sql)
    LOOP
      should_create := FALSE;

      SELECT c.oid, i.indrelid, i.indisvalid
      INTO idx_oid, idx_rel_oid, idx_is_valid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relkind = 'i'
        AND n.nspname = 'public'
        AND c.relname = row_rec.idx_name;

      IF idx_oid IS NOT NULL THEN
        IF idx_rel_oid = mv_oid AND idx_is_valid THEN
          RAISE NOTICE '[stop-search] keeping existing index % on stop_search_index_new', row_rec.idx_name;
        ELSE
          RAISE NOTICE '[stop-search] dropping stale index % before recreate', row_rec.idx_name;
          EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.idx_name);
          should_create := TRUE;
        END IF;
      ELSE
        should_create := TRUE;
      END IF;

      IF should_create THEN
        RAISE NOTICE '[stop-search] creating index % on stop_search_index_new', row_rec.idx_name;
        EXECUTE row_rec.create_sql;
      END IF;
    END LOOP;
  ELSE
    RAISE NOTICE '[stop-search] skip trigram indexes on stop_search_index_new (pg_trgm unavailable)';
  END IF;
END
$$;

\echo '[stop-search] Created indexes on stop_search_index_new'

-- ───────────────────────────────────────────────────────────────────────────────────
-- ATOMIC SWAP: Promote _new to live
-- ───────────────────────────────────────────────────────────────────────────────────
-- Keep lock duration minimal (just the renames)

\echo '[stop-search] Swapping stop_search_index...'

-- If old index exists, rename it to _old
DROP MATERIALIZED VIEW IF EXISTS public.stop_search_index_old CASCADE;

ALTER MATERIALIZED VIEW IF EXISTS public.stop_search_index RENAME TO stop_search_index_old;

-- Promote _new to live name
ALTER MATERIALIZED VIEW public.stop_search_index_new RENAME TO stop_search_index;

DO $$
DECLARE
  live_rel_oid OID;
  old_rel_oid OID;
  row_rec RECORD;
  canonical_idx_oid OID;
  canonical_idx_rel_oid OID;
  canonical_idx_is_valid BOOLEAN;
  new_idx_oid OID;
  new_idx_rel_oid OID;
  new_idx_is_valid BOOLEAN;
  old_idx_oid OID;
  old_idx_rel_oid OID;
BEGIN
  SELECT c.oid
  INTO live_rel_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'stop_search_index'
    AND c.relkind = 'm';

  SELECT c.oid
  INTO old_rel_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'stop_search_index_old'
    AND c.relkind = 'm';

  IF live_rel_oid IS NULL THEN
    RAISE EXCEPTION '[stop-search] stop_search_index missing after swap';
  END IF;

  FOR row_rec IN
    SELECT *
    FROM (
      VALUES
        (
          'idx_stop_search_index_stop_id',
          'idx_stop_search_index_new_stop_id',
          'idx_stop_search_index_old_stop_id',
          'CREATE UNIQUE INDEX idx_stop_search_index_stop_id ON public.stop_search_index (stop_id)'
        ),
        (
          'idx_stop_search_index_group_id',
          'idx_stop_search_index_new_group_id',
          'idx_stop_search_index_old_group_id',
          'CREATE INDEX idx_stop_search_index_group_id ON public.stop_search_index (group_id)'
        ),
        (
          'idx_stop_search_index_is_parent',
          'idx_stop_search_index_new_is_parent',
          'idx_stop_search_index_old_is_parent',
          'CREATE INDEX idx_stop_search_index_is_parent ON public.stop_search_index (is_parent)'
        ),
        (
          'idx_stop_search_index_name_norm_prefix',
          'idx_stop_search_index_new_name_norm_prefix',
          'idx_stop_search_index_old_name_norm_prefix',
          'CREATE INDEX idx_stop_search_index_name_norm_prefix ON public.stop_search_index (name_norm text_pattern_ops)'
        ),
        (
          'idx_stop_search_index_search_text_trgm',
          'idx_stop_search_index_new_search_text_trgm',
          'idx_stop_search_index_old_search_text_trgm',
          'CREATE INDEX idx_stop_search_index_search_text_trgm ON public.stop_search_index USING GIN (search_text gin_trgm_ops)'
        ),
        (
          'idx_stop_search_index_name_norm_trgm',
          'idx_stop_search_index_new_name_norm_trgm',
          'idx_stop_search_index_old_name_norm_trgm',
          'CREATE INDEX idx_stop_search_index_name_norm_trgm ON public.stop_search_index USING GIN (name_norm gin_trgm_ops)'
        ),
        (
          'idx_stop_search_index_name_core_trgm',
          'idx_stop_search_index_new_name_core_trgm',
          'idx_stop_search_index_old_name_core_trgm',
          'CREATE INDEX idx_stop_search_index_name_core_trgm ON public.stop_search_index USING GIN (name_core gin_trgm_ops)'
        ),
        (
          'idx_stop_search_index_parent_name_norm_trgm',
          'idx_stop_search_index_new_parent_name_norm_trgm',
          'idx_stop_search_index_old_parent_name_norm_trgm',
          'CREATE INDEX idx_stop_search_index_parent_name_norm_trgm ON public.stop_search_index USING GIN (parent_name_norm gin_trgm_ops)'
        )
    ) AS idx_map(canonical_name, new_name, old_name, create_live_sql)
  LOOP
    IF row_rec.canonical_name LIKE '%_trgm'
       AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
      CONTINUE;
    END IF;

    SELECT c.oid, i.indrelid
    INTO old_idx_oid, old_idx_rel_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.old_name;

    IF old_idx_oid IS NOT NULL THEN
      RAISE NOTICE '[stop-search] dropping old-name index % before swap-rename reconciliation', row_rec.old_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.old_name);
    END IF;

    IF old_rel_oid IS NOT NULL THEN
      SELECT c.oid, i.indrelid
      INTO canonical_idx_oid, canonical_idx_rel_oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relkind = 'i'
        AND n.nspname = 'public'
        AND c.relname = row_rec.canonical_name;

      IF canonical_idx_oid IS NOT NULL AND canonical_idx_rel_oid = old_rel_oid THEN
        RAISE NOTICE '[stop-search] renaming old live index % -> %', row_rec.canonical_name, row_rec.old_name;
        EXECUTE format('ALTER INDEX public.%I RENAME TO %I', row_rec.canonical_name, row_rec.old_name);
      END IF;
    END IF;

    SELECT c.oid, i.indrelid, i.indisvalid
    INTO canonical_idx_oid, canonical_idx_rel_oid, canonical_idx_is_valid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.canonical_name;

    IF canonical_idx_oid IS NOT NULL AND canonical_idx_rel_oid IS DISTINCT FROM live_rel_oid THEN
      RAISE NOTICE '[stop-search] dropping stale canonical index %', row_rec.canonical_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.canonical_name);
      canonical_idx_oid := NULL;
      canonical_idx_rel_oid := NULL;
      canonical_idx_is_valid := NULL;
    END IF;

    SELECT c.oid, i.indrelid, i.indisvalid
    INTO new_idx_oid, new_idx_rel_oid, new_idx_is_valid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.new_name;

    IF new_idx_oid IS NOT NULL AND new_idx_rel_oid IS DISTINCT FROM live_rel_oid THEN
      RAISE NOTICE '[stop-search] dropping stale new-name index %', row_rec.new_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.new_name);
      new_idx_oid := NULL;
      new_idx_rel_oid := NULL;
      new_idx_is_valid := NULL;
    END IF;

    IF canonical_idx_oid IS NOT NULL AND canonical_idx_rel_oid = live_rel_oid AND canonical_idx_is_valid IS DISTINCT FROM TRUE THEN
      RAISE NOTICE '[stop-search] dropping invalid canonical index %', row_rec.canonical_name;
      EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.canonical_name);
      canonical_idx_oid := NULL;
      canonical_idx_rel_oid := NULL;
      canonical_idx_is_valid := NULL;
    END IF;

    IF canonical_idx_oid IS NULL THEN
      IF new_idx_oid IS NOT NULL AND new_idx_rel_oid = live_rel_oid AND new_idx_is_valid THEN
        RAISE NOTICE '[stop-search] renaming % -> % on stop_search_index', row_rec.new_name, row_rec.canonical_name;
        EXECUTE format('ALTER INDEX public.%I RENAME TO %I', row_rec.new_name, row_rec.canonical_name);
      ELSE
        IF new_idx_oid IS NOT NULL THEN
          RAISE NOTICE '[stop-search] dropping invalid new-name index % before rebuild', row_rec.new_name;
          EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.new_name);
        END IF;
        RAISE NOTICE '[stop-search] creating missing canonical index % on stop_search_index', row_rec.canonical_name;
        EXECUTE row_rec.create_live_sql;
      END IF;
    ELSE
      IF new_idx_oid IS NOT NULL AND new_idx_rel_oid = live_rel_oid THEN
        RAISE NOTICE '[stop-search] dropping duplicate new-name index % after canonical rename', row_rec.new_name;
        EXECUTE format('DROP INDEX IF EXISTS public.%I', row_rec.new_name);
      END IF;
    END IF;
  END LOOP;
END
$$;

\echo '[stop-search] Swapped stop_search_index (old->old, new->live)'

-- ───────────────────────────────────────────────────────────────────────────────────
-- CLEANUP: Drop old view (indexes dropped by CASCADE)
-- ───────────────────────────────────────────────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS public.stop_search_index_old CASCADE;
\echo '[stop-search] Dropped old stop_search_index and its indexes'

DO $$
DECLARE
  live_rel_oid OID;
  row_rec RECORD;
  idx_rel_oid OID;
  idx_is_valid BOOLEAN;
BEGIN
  IF to_regclass('public.stop_search_index') IS NULL THEN
    RAISE EXCEPTION '[stop-search] verification failed: public.stop_search_index is missing';
  END IF;

  IF to_regclass('public.stop_search_index_new') IS NOT NULL THEN
    RAISE EXCEPTION '[stop-search] verification failed: public.stop_search_index_new still exists';
  END IF;

  SELECT c.oid
  INTO live_rel_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'stop_search_index'
    AND c.relkind = 'm';

  FOR row_rec IN
    SELECT *
    FROM (
      VALUES
        ('idx_stop_search_index_stop_id'),
        ('idx_stop_search_index_group_id'),
        ('idx_stop_search_index_is_parent'),
        ('idx_stop_search_index_name_norm_prefix')
    ) AS idx_names(idx_name)
  LOOP
    SELECT i.indrelid, i.indisvalid
    INTO idx_rel_oid, idx_is_valid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname = row_rec.idx_name;

    IF idx_rel_oid IS DISTINCT FROM live_rel_oid OR idx_is_valid IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION '[stop-search] verification failed: % missing/invalid on stop_search_index', row_rec.idx_name;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    FOR row_rec IN
      SELECT *
      FROM (
        VALUES
          ('idx_stop_search_index_search_text_trgm'),
          ('idx_stop_search_index_name_norm_trgm'),
          ('idx_stop_search_index_name_core_trgm'),
          ('idx_stop_search_index_parent_name_norm_trgm')
      ) AS idx_names(idx_name)
    LOOP
      SELECT i.indrelid, i.indisvalid
      INTO idx_rel_oid, idx_is_valid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relkind = 'i'
        AND n.nspname = 'public'
        AND c.relname = row_rec.idx_name;

      IF idx_rel_oid IS DISTINCT FROM live_rel_oid OR idx_is_valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[stop-search] verification failed: % missing/invalid on stop_search_index', row_rec.idx_name;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND c.relname LIKE 'idx_stop_search_index_new_%'
      AND i.indrelid = live_rel_oid
  ) THEN
    RAISE EXCEPTION '[stop-search] verification failed: _new indexes still attached to stop_search_index';
  END IF;

  RAISE NOTICE '[stop-search] verification passed: canonical stop_search_index and indexes are healthy';
END
$$;

-- Create index on gtfs_stops for reference (idempotent)
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_stop_name_lower_prefix
ON public.gtfs_stops ((lower(stop_name)) text_pattern_ops);

-- ───────────────────────────────────────────────────────────────────────────────────
-- ANALYZE for query planner
-- ───────────────────────────────────────────────────────────────────────────────────

ANALYZE public.gtfs_stops;
ANALYZE public.stop_aliases;
ANALYZE public.stop_alias_seed_specs;
ANALYZE public.stop_search_index;

\echo '[stop-search] Analyzed tables for query planner'

COMMIT;

\echo '[stop-search] Zero-downtime stop search rebuild complete'
