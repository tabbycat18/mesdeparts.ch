const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;
const MIN_QUERY_LEN = 2;

const CANDIDATE_MIN = 60;
const CANDIDATE_MAX = 320;
const CANDIDATE_MULTIPLIER = 20;

const GENERIC_STOP_WORDS = new Set([
  "gare",
  "bahnhof",
  "station",
  "stazione",
  "bahnhofplatz",
]);

const HUB_WORDS = new Set(["hb", "hbf", "hauptbahnhof"]);

function toString(value) {
  if (value == null) return "";
  return String(value);
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(parsed)));
}

function candidateLimitFor(limit) {
  return Math.min(CANDIDATE_MAX, Math.max(CANDIDATE_MIN, limit * CANDIDATE_MULTIPLIER));
}

export function normalizeSearchText(value) {
  const raw = toString(value).trim().toLowerCase();
  if (!raw) return "";

  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[-_.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripStopWords(normalizedText) {
  const tokens = tokenize(normalizedText);
  if (tokens.length === 0) return "";
  return tokens
    .filter((token) => !GENERIC_STOP_WORDS.has(token))
    .join(" ")
    .trim();
}

function tokenize(normalizedText) {
  const text = normalizeSearchText(normalizedText);
  if (!text) return [];
  return text.split(" ").filter(Boolean);
}

function tokenPrefixes(tokens) {
  const out = new Set();
  for (const token of tokens) {
    if (!token) continue;
    if (token.length >= 4) out.add(token.slice(0, 4));
    if (token.length >= 3) out.add(token.slice(0, 3));
    if (token.length >= 2) out.add(token.slice(0, 2));
  }
  return Array.from(out);
}

function hasHubWord(tokens) {
  return tokens.some((token) => HUB_WORDS.has(token));
}

function isParentLike(row) {
  const stopId = toString(row?.stop_id).trim();
  const parentStation = toString(row?.parent_station).trim();
  const locationType = toString(row?.location_type).trim();
  return !parentStation || locationType === "1" || stopId.startsWith("Parent");
}

function extractCityName(stopName, providedCity = "") {
  const fromProvided = toString(providedCity).trim();
  if (fromProvided) return fromProvided;

  const rawName = toString(stopName).trim();
  if (!rawName) return "";
  if (rawName.includes(",")) {
    return rawName.split(",")[0].trim();
  }

  const words = rawName.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return words.slice(0, 2).join(" ").trim();
}

function boundedLevenshtein(a, b, maxDistance) {
  const left = toString(a);
  const right = toString(b);

  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_v, i) => i);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    const leftCode = left.charCodeAt(i - 1);

    for (let j = 1; j <= right.length; j += 1) {
      const cost = leftCode === right.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[right.length];
}

function wordStartMatch(queryTokens, candidateTokens) {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return false;
  return queryTokens.every((token) =>
    candidateTokens.some((candidateToken) => candidateToken.startsWith(token))
  );
}

function tokenContainmentMatch(queryTokens, candidateTokens) {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return false;
  return queryTokens.every((token) =>
    candidateTokens.some((candidateToken) => candidateToken.includes(token))
  );
}

function dedupeAliases(aliases) {
  const seen = new Set();
  const out = [];
  for (const alias of aliases || []) {
    const trimmed = toString(alias).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function similarityThreshold(queryLength) {
  if (queryLength <= 4) return 0.72;
  if (queryLength <= 6) return 0.62;
  if (queryLength <= 8) return 0.52;
  return 0.44;
}

function computeFuzzySimilarity({
  queryNorm,
  queryCore,
  queryTokens,
  nameNorm,
  coreNorm,
  candidateTokens,
  dbSimilarity,
}) {
  let best = Math.max(0, toFiniteNumber(dbSimilarity, 0));

  const maxDistance = queryNorm.length <= 4 ? 1 : 2;

  const fullDistance = boundedLevenshtein(queryNorm, nameNorm, maxDistance + 1);
  if (fullDistance <= maxDistance) {
    const ratio = 1 - fullDistance / Math.max(queryNorm.length, nameNorm.length, 1);
    if (ratio > best) best = ratio;
  }

  if (queryCore && coreNorm) {
    const coreDistance = boundedLevenshtein(queryCore, coreNorm, maxDistance + 1);
    if (coreDistance <= maxDistance) {
      const ratio = 1 - coreDistance / Math.max(queryCore.length, coreNorm.length, 1);
      if (ratio > best) best = ratio;
    }
  }

  for (const qToken of queryTokens) {
    for (const cToken of candidateTokens) {
      const tokenDistance = boundedLevenshtein(qToken, cToken, maxDistance);
      if (tokenDistance > maxDistance) continue;
      const ratio = 1 - tokenDistance / Math.max(qToken.length, cToken.length, 1);
      if (ratio > best) best = ratio;
    }
  }

  return best;
}

function compareScored(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.parentBoost !== b.parentBoost) return b.parentBoost - a.parentBoost;
  const nameCmp = a.stopName.localeCompare(b.stopName, "en", { sensitivity: "base" });
  if (nameCmp !== 0) return nameCmp;
  return a.stopId.localeCompare(b.stopId);
}

function scoreCandidate(row, queryCtx) {
  const stopName = toString(row?.stop_name).trim();
  const stopId = toString(row?.stop_id).trim();
  const groupId = toString(row?.group_id).trim() || stopId;
  if (!stopName || !stopId) return null;

  const nameNormRaw = toString(row?.name_norm).trim();
  const coreNormRaw = toString(row?.name_core).trim();

  const nameNorm = nameNormRaw ? normalizeSearchText(nameNormRaw) : normalizeSearchText(stopName);
  const coreNorm = coreNormRaw ? normalizeSearchText(coreNormRaw) : stripStopWords(nameNorm);

  if (!nameNorm) return null;

  const aliasesMatched = dedupeAliases(row?.aliases_matched);
  const aliasNorms = aliasesMatched.map((alias) => normalizeSearchText(alias)).filter(Boolean);

  const nameTokens = tokenize(nameNorm);
  const coreTokens = tokenize(coreNorm);
  const candidateTokens = coreTokens.length > 0 ? coreTokens : nameTokens;

  const aliasWeight = toFiniteNumber(row?.alias_weight, 0);
  const aliasSimilarity = toFiniteNumber(row?.alias_similarity, 0);
  const nameSimilarity = toFiniteNumber(row?.name_similarity, 0);
  const coreSimilarity = toFiniteNumber(row?.core_similarity, 0);
  const dbSimilarity = Math.max(nameSimilarity, coreSimilarity, aliasSimilarity);

  const exactName = nameNorm === queryCtx.queryNorm || (queryCtx.queryCore && coreNorm === queryCtx.queryCore);
  const exactAlias = aliasNorms.some(
    (aliasNorm) => aliasNorm === queryCtx.queryNorm || (queryCtx.queryCore && aliasNorm === queryCtx.queryCore)
  );

  const prefixName =
    nameNorm.startsWith(queryCtx.queryNorm) ||
    (queryCtx.queryCore ? coreNorm.startsWith(queryCtx.queryCore) : false);
  const prefixAlias = aliasNorms.some((aliasNorm) => aliasNorm.startsWith(queryCtx.queryNorm));

  const startsMatch = wordStartMatch(queryCtx.queryTokens, candidateTokens);
  const tokenContains = tokenContainmentMatch(queryCtx.queryTokens, candidateTokens);

  const fuzzySimilarity = computeFuzzySimilarity({
    queryNorm: queryCtx.queryNorm,
    queryCore: queryCtx.queryCore,
    queryTokens: queryCtx.queryTokens,
    nameNorm,
    coreNorm,
    candidateTokens,
    dbSimilarity,
  });

  const fuzzyAccepted = fuzzySimilarity >= queryCtx.fuzzyThreshold;

  let tier = 0;
  if (exactName || exactAlias) tier = 4;
  else if (prefixName || prefixAlias) tier = 3;
  else if (startsMatch) tier = 2;
  else if (fuzzyAccepted) tier = 1;
  else if (tokenContains && fuzzySimilarity >= queryCtx.fuzzyThreshold - 0.08) tier = 1;

  if (tier === 0) return null;

  const parentLike = isParentLike(row);
  const parentBoost = queryCtx.isShortQuery ? (parentLike ? 1 : -1) : parentLike ? 1 : 0;

  const cityName = extractCityName(stopName, row?.city_name);
  const cityNorm = normalizeSearchText(cityName);

  const cityMatch =
    !!queryCtx.cityToken &&
    (cityNorm === queryCtx.cityToken ||
      nameNorm.startsWith(`${queryCtx.cityToken} `) ||
      nameNorm === queryCtx.cityToken);

  const candidateHasHubToken = hasHubWord(candidateTokens) || hasHubWord(nameTokens);

  let score = tier * 10_000;
  score += Math.round(fuzzySimilarity * 1000);

  if (exactAlias) score += 1700;
  else if (prefixAlias) score += 900;

  score += Math.round(aliasWeight * 260);

  if (cityMatch) score += 220;
  if (cityMatch && parentLike) score += 280;

  if (candidateHasHubToken && cityMatch && !queryCtx.queryHasHubToken) {
    score += 1100;
  } else if (candidateHasHubToken && queryCtx.queryHasHubToken) {
    score += 700;
  }

  if (queryCtx.isShortQuery) {
    score += parentLike ? 350 : -220;
  } else {
    score += parentLike ? 120 : 0;
  }

  if (tokenContains) score += 120;
  if (startsMatch) score += 180;

  return {
    score,
    tier,
    parentBoost,
    stopId,
    groupId,
    stopName,
    parentStation: toString(row?.parent_station).trim() || null,
    locationType: toString(row?.location_type).trim(),
    nbStopTimes: Math.max(0, Math.round(toFiniteNumber(row?.nb_stop_times, 0))),
    cityName,
    cityNorm,
    aliasesMatched,
  };
}

export function rankStopCandidates(rows, query, limit = DEFAULT_LIMIT) {
  const lim = clampLimit(limit);
  const queryNorm = normalizeSearchText(query);
  if (queryNorm.length < MIN_QUERY_LEN) return [];

  const queryCore = stripStopWords(queryNorm);
  const queryTokens = tokenize(queryCore || queryNorm);
  const cityToken = queryTokens[0] || "";

  const queryCtx = {
    queryNorm,
    queryCore,
    queryTokens,
    cityToken,
    isShortQuery: queryNorm.length <= 6,
    queryHasHubToken: hasHubWord(queryTokens),
    fuzzyThreshold: similarityThreshold(queryNorm.length),
  };

  const bestByGroup = new Map();

  for (const row of rows || []) {
    const scored = scoreCandidate(row, queryCtx);
    if (!scored) continue;

    const key = scored.groupId || scored.stopId;
    const previous = bestByGroup.get(key);
    if (!previous || compareScored(scored, previous) < 0) {
      bestByGroup.set(key, scored);
    }
  }

  const ordered = Array.from(bestByGroup.values()).sort(compareScored);

  return ordered.slice(0, lim).map((row) => {
    const canonicalId = row.groupId || row.stopId;
    const out = {
      id: canonicalId,
      name: row.stopName,
      stop_id: canonicalId,
      group_id: canonicalId,
      raw_stop_id: row.stopId,
      stop_name: row.stopName,
      parent_station: row.parentStation,
      location_type: row.locationType,
      nb_stop_times: row.nbStopTimes,
      city: row.cityName || null,
      canton: null,
    };

    if (row.aliasesMatched.length > 0) {
      out.aliasesMatched = row.aliasesMatched.slice(0, 5);
    }

    return out;
  });
}

const PRIMARY_SQL = `
WITH params AS (
  SELECT
    public.normalize_stop_search_text($1::text) AS q_norm,
    public.strip_stop_search_terms(public.normalize_stop_search_text($1::text)) AS q_core,
    CASE
      WHEN char_length(public.normalize_stop_search_text($1::text)) <= 4 THEN 0.48
      WHEN char_length(public.normalize_stop_search_text($1::text)) <= 6 THEN 0.40
      WHEN char_length(public.normalize_stop_search_text($1::text)) <= 8 THEN 0.34
      ELSE 0.28
    END AS sim_threshold
),
alias_hits AS (
  SELECT
    sa.stop_id,
    ARRAY_AGG(DISTINCT sa.alias_text ORDER BY sa.alias_text) AS aliases_matched,
    MAX(sa.weight)::float8 AS alias_weight,
    MAX(similarity(public.normalize_stop_search_text(sa.alias_text), p.q_norm))::float8 AS alias_similarity
  FROM public.stop_aliases sa
  CROSS JOIN params p
  WHERE
    p.q_norm <> ''
    AND (
      public.normalize_stop_search_text(sa.alias_text) = p.q_norm
      OR public.normalize_stop_search_text(sa.alias_text) LIKE p.q_norm || '%'
      OR similarity(public.normalize_stop_search_text(sa.alias_text), p.q_norm) >= p.sim_threshold
    )
  GROUP BY sa.stop_id
),
base AS (
  SELECT
    s.stop_id,
    s.stop_name,
    NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
    COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
    COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
    public.normalize_stop_search_text(s.stop_name) AS name_norm,
    public.strip_stop_search_terms(public.normalize_stop_search_text(s.stop_name)) AS name_core,
    trim(split_part(s.stop_name, ',', 1)) AS city_name
  FROM public.gtfs_stops s
)
SELECT
  b.group_id,
  b.stop_id,
  b.stop_name,
  b.parent_station,
  b.location_type,
  b.city_name,
  b.name_norm,
  b.name_core,
  COALESCE(ahs.aliases_matched, ahg.aliases_matched, ARRAY[]::text[]) AS aliases_matched,
  GREATEST(COALESCE(ahs.alias_weight, 0), COALESCE(ahg.alias_weight, 0))::float8 AS alias_weight,
  GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0))::float8 AS alias_similarity,
  similarity(b.name_norm, p.q_norm)::float8 AS name_similarity,
  CASE
    WHEN p.q_core = '' THEN 0::float8
    ELSE similarity(b.name_core, p.q_core)::float8
  END AS core_similarity,
  0::int AS nb_stop_times
FROM base b
CROSS JOIN params p
LEFT JOIN alias_hits ahs ON ahs.stop_id = b.stop_id
LEFT JOIN alias_hits ahg ON ahg.stop_id = b.group_id
WHERE
  p.q_norm <> ''
  AND (
    b.name_norm = p.q_norm
    OR b.name_norm LIKE p.q_norm || '%'
    OR b.name_norm LIKE '%' || p.q_norm || '%'
    OR b.name_norm % p.q_norm
    OR (p.q_core <> '' AND (b.name_core LIKE p.q_core || '%' OR b.name_core % p.q_core))
    OR GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0)) >= p.sim_threshold
    OR GREATEST(COALESCE(ahs.alias_weight, 0), COALESCE(ahg.alias_weight, 0)) > 0
  )
ORDER BY
  GREATEST(
    CASE WHEN b.name_norm = p.q_norm THEN 1.5 ELSE 0 END,
    CASE WHEN b.name_norm LIKE p.q_norm || '%' THEN 1.2 ELSE 0 END,
    similarity(b.name_norm, p.q_norm),
    CASE WHEN p.q_core = '' THEN 0 ELSE similarity(b.name_core, p.q_core) END,
    GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0))
  ) DESC,
  (b.parent_station IS NULL OR b.location_type = '1' OR b.stop_id LIKE 'Parent%') DESC,
  b.stop_name ASC
LIMIT $2;
`;

const FALLBACK_SQL = `
WITH base AS (
  SELECT
    s.stop_id,
    s.stop_name,
    NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
    COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
    COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
    trim(split_part(s.stop_name, ',', 1)) AS city_name
  FROM public.gtfs_stops s
  WHERE
    lower(s.stop_name) LIKE '%' || $1 || '%'
    OR lower(s.stop_name) LIKE ANY($2::text[])
)
SELECT
  b.group_id,
  b.stop_id,
  b.stop_name,
  b.parent_station,
  b.location_type,
  b.city_name,
  ARRAY[]::text[] AS aliases_matched,
  0::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  0::int AS nb_stop_times
FROM base b
LIMIT $3;
`;

const FALLBACK_STOP_ALIASES_SQL = `
SELECT
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  ARRAY[sa.alias_text]::text[] AS aliases_matched,
  COALESCE(sa.weight, 1)::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  0::int AS nb_stop_times
FROM public.stop_aliases sa
JOIN public.gtfs_stops s ON s.stop_id = sa.stop_id
WHERE
  lower(sa.alias_text) LIKE '%' || $1 || '%'
  OR lower(sa.alias_text) LIKE ANY($2::text[])
LIMIT $3;
`;

const FALLBACK_APP_ALIASES_SQL = `
SELECT
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  ARRAY[a.alias]::text[] AS aliases_matched,
  1::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  0::int AS nb_stop_times
FROM public.app_stop_aliases a
JOIN public.gtfs_stops s ON s.stop_id = a.stop_id
WHERE
  lower(a.alias) LIKE '%' || $1 || '%'
  OR lower(a.alias) LIKE ANY($2::text[])
LIMIT $3;
`;

async function getAliasTableCapabilities(db) {
  try {
    const result = await db.query(
      `
      SELECT
        to_regclass('public.stop_aliases') IS NOT NULL AS has_stop_aliases,
        to_regclass('public.app_stop_aliases') IS NOT NULL AS has_app_stop_aliases
      `
    );
    const row = result.rows?.[0] || {};
    return {
      hasStopAliases: row.has_stop_aliases === true,
      hasAppStopAliases: row.has_app_stop_aliases === true,
    };
  } catch {
    return { hasStopAliases: false, hasAppStopAliases: false };
  }
}

async function fetchFallbackAliasRows(db, queryNorm, candidateLimit) {
  const prefixes = tokenPrefixes(tokenize(queryNorm));
  const likePatterns = prefixes.map((prefix) => `%${prefix}%`);

  const caps = await getAliasTableCapabilities(db);
  const rows = [];

  if (caps.hasStopAliases) {
    const stopAliasRes = await db.query(FALLBACK_STOP_ALIASES_SQL, [queryNorm, likePatterns, candidateLimit]);
    rows.push(...(stopAliasRes.rows || []));
  }

  if (caps.hasAppStopAliases) {
    const appAliasRes = await db.query(FALLBACK_APP_ALIASES_SQL, [queryNorm, likePatterns, candidateLimit]);
    rows.push(...(appAliasRes.rows || []));
  }

  return rows;
}

async function runFallbackSearch(db, queryNorm, candidateLimit) {
  const prefixes = tokenPrefixes(tokenize(queryNorm));
  const likePatterns = prefixes.map((prefix) => `%${prefix}%`);

  const baseRes = await db.query(FALLBACK_SQL, [queryNorm, likePatterns, candidateLimit]);
  const baseRows = baseRes.rows || [];

  let aliasRows = [];
  try {
    aliasRows = await fetchFallbackAliasRows(db, queryNorm, candidateLimit);
  } catch {
    aliasRows = [];
  }

  return baseRows.concat(aliasRows);
}

export async function searchStops(db, query, limit = DEFAULT_LIMIT) {
  const qRaw = toString(query).trim();
  const qNorm = normalizeSearchText(qRaw);
  if (qNorm.length < MIN_QUERY_LEN) return [];

  const lim = clampLimit(limit);
  const candidateLimit = candidateLimitFor(lim);

  let rows = [];
  let primaryError = null;

  try {
    const result = await db.query(PRIMARY_SQL, [qRaw, candidateLimit]);
    rows = result.rows || [];
  } catch (err) {
    primaryError = err;
  }

  if (primaryError || rows.length < Math.min(candidateLimit, lim * 3)) {
    try {
      const fallbackRows = await runFallbackSearch(db, qNorm, candidateLimit);
      rows = rows.concat(fallbackRows);
    } catch (fallbackErr) {
      if (primaryError) {
        fallbackErr.cause = primaryError;
      }
      throw fallbackErr;
    }
  }

  return rankStopCandidates(rows, qNorm, lim);
}
