-- Migration: Add JSONB columns for multi-language alert translations
-- This allows storing all available languages from GTFS-RT feed instead of just one.
--
-- Schema:
--   header_translations: [{language: "de", text: "..."}, {language: "fr", text: "..."}, ...]
--   description_translations: same structure
--
-- Fallback behavior: If JSONB columns are null/empty, use header_text / description_text as single-language.

ALTER TABLE public.rt_service_alerts
ADD COLUMN header_translations jsonb DEFAULT NULL,
ADD COLUMN description_translations jsonb DEFAULT NULL;

COMMENT ON COLUMN public.rt_service_alerts.header_translations IS
  'Full multi-language translations array: [{language: "de", text: "..."}, ...]. If null, fall back to header_text.';

COMMENT ON COLUMN public.rt_service_alerts.description_translations IS
  'Full multi-language translations array: [{language: "de", text: "..."}, ...]. If null, fall back to description_text.';

-- Index for potential future queries
CREATE INDEX IF NOT EXISTS idx_rt_service_alerts_header_translations
ON public.rt_service_alerts USING GIN (header_translations);

CREATE INDEX IF NOT EXISTS idx_rt_service_alerts_description_translations
ON public.rt_service_alerts USING GIN (description_translations);
