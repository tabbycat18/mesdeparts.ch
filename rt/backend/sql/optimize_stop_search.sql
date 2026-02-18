-- Forgiving stop search setup (idempotent).
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/optimize_stop_search.sql

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.md_unaccent(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT public.unaccent('unaccent'::regdictionary, input);
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
          lower(public.md_unaccent(input)),
          '[-_.]+',
          ' ',
          'g'
        ),
        '[^[:alnum:][:space:]]+',
        ' ',
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
        COALESCE(input, ''),
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
      stop_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0
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
      AND column_name = 'weight'
  ) THEN
    ALTER TABLE public.stop_aliases
      ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stop_aliases_alias_text_unique
ON public.stop_aliases (alias_text);

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_search_norm_prefix
ON public.gtfs_stops (public.normalize_stop_search_text(stop_name) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_search_norm_trgm
ON public.gtfs_stops USING GIN (public.normalize_stop_search_text(stop_name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_search_core_trgm
ON public.gtfs_stops USING GIN (
  public.strip_stop_search_terms(public.normalize_stop_search_text(stop_name)) gin_trgm_ops
);

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_group_id
ON public.gtfs_stops ((COALESCE(NULLIF(parent_station, ''), stop_id)));

CREATE INDEX IF NOT EXISTS idx_stop_aliases_stop_id
ON public.stop_aliases (stop_id);

CREATE INDEX IF NOT EXISTS idx_stop_aliases_alias_norm_prefix
ON public.stop_aliases (public.normalize_stop_search_text(alias_text) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_stop_aliases_alias_norm_trgm
ON public.stop_aliases USING GIN (public.normalize_stop_search_text(alias_text) gin_trgm_ops);

DO $$
BEGIN
  IF to_regclass('public.app_stop_aliases') IS NOT NULL THEN
    INSERT INTO public.stop_aliases (alias_text, stop_id, weight)
    SELECT a.alias, a.stop_id, 1.20::real
    FROM public.app_stop_aliases a
    ON CONFLICT (alias_text)
    DO UPDATE SET
      stop_id = EXCLUDED.stop_id,
      weight = GREATEST(public.stop_aliases.weight, EXCLUDED.weight);
  END IF;
END
$$;

WITH explicit_aliases(alias_text, stop_id, weight) AS (
  VALUES
    ('cornavin', 'Parent8501008', 9.00::real),
    ('gare cornavin', 'Parent8501008', 9.00::real),
    ('geneve cornavin', 'Parent8501008', 8.50::real),
    ('geneva cornavin', 'Parent8501008', 8.00::real),
    ('genf cornavin', 'Parent8501008', 8.00::real),
    ('zurich hb', 'Parent8503000', 9.00::real),
    ('zuerich hb', 'Parent8503000', 9.00::real),
    ('zurich hbf', 'Parent8503000', 8.50::real),
    ('zuerich hbf', 'Parent8503000', 8.50::real),
    ('hauptbahnhof zurich', 'Parent8503000', 8.50::real),
    ('zurich hauptbahnhof', 'Parent8503000', 8.50::real)
)
INSERT INTO public.stop_aliases (alias_text, stop_id, weight)
SELECT ea.alias_text, ea.stop_id, ea.weight
FROM explicit_aliases ea
WHERE EXISTS (
  SELECT 1
  FROM public.gtfs_stops s
  WHERE s.stop_id = ea.stop_id
)
ON CONFLICT (alias_text)
DO UPDATE SET
  stop_id = EXCLUDED.stop_id,
  weight = GREATEST(public.stop_aliases.weight, EXCLUDED.weight);

WITH stop_counts AS (
  SELECT
    st.stop_id,
    COUNT(*)::bigint AS dep_count
  FROM public.gtfs_stop_times st
  GROUP BY st.stop_id
),
station_groups AS (
  SELECT
    COALESCE(NULLIF(s.parent_station, ''), s.stop_id) AS group_id,
    MAX(
      CASE
        WHEN NULLIF(s.parent_station, '') IS NULL
          OR COALESCE(NULLIF(s.location_type, ''), '') = '1'
          OR s.stop_id LIKE 'Parent%'
        THEN s.stop_name
        ELSE NULL
      END
    ) AS preferred_name,
    MIN(s.stop_name) AS fallback_name,
    SUM(COALESCE(sc.dep_count, 0))::bigint AS group_dep_count
  FROM public.gtfs_stops s
  LEFT JOIN stop_counts sc ON sc.stop_id = s.stop_id
  GROUP BY 1
),
top_50_major_stations AS (
  SELECT
    sg.group_id AS stop_id,
    COALESCE(NULLIF(sg.preferred_name, ''), sg.fallback_name) AS stop_name,
    sg.group_dep_count
  FROM station_groups sg
  WHERE COALESCE(NULLIF(sg.preferred_name, ''), sg.fallback_name) IS NOT NULL
  ORDER BY sg.group_dep_count DESC NULLS LAST, COALESCE(NULLIF(sg.preferred_name, ''), sg.fallback_name) ASC
  LIMIT 50
),
auto_aliases AS (
  SELECT stop_id, alias_text, weight
  FROM (
    SELECT
      t.stop_id,
      public.normalize_stop_search_text(t.stop_name) AS alias_text,
      1.20::real AS weight
    FROM top_50_major_stations t

    UNION ALL

    SELECT
      t.stop_id,
      trim(replace(public.normalize_stop_search_text(t.stop_name), ',', ' ')) AS alias_text,
      1.10::real AS weight
    FROM top_50_major_stations t

    UNION ALL

    SELECT
      t.stop_id,
      public.strip_stop_search_terms(public.normalize_stop_search_text(t.stop_name)) AS alias_text,
      1.05::real AS weight
    FROM top_50_major_stations t

    UNION ALL

    SELECT
      t.stop_id,
      trim(split_part(public.normalize_stop_search_text(t.stop_name), ',', 1)) AS alias_text,
      0.90::real AS weight
    FROM top_50_major_stations t
  ) generated
  WHERE alias_text IS NOT NULL
    AND alias_text <> ''
    AND char_length(alias_text) >= 3
)
INSERT INTO public.stop_aliases (alias_text, stop_id, weight)
SELECT
  aa.alias_text,
  aa.stop_id,
  aa.weight
FROM auto_aliases aa
ON CONFLICT (alias_text)
DO UPDATE SET
  stop_id = EXCLUDED.stop_id,
  weight = GREATEST(public.stop_aliases.weight, EXCLUDED.weight);

ANALYZE public.gtfs_stops;
ANALYZE public.stop_aliases;
