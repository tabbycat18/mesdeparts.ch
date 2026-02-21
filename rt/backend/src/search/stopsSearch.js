import { normalizeStopSearchText } from "../util/searchNormalize.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;
const MIN_QUERY_LEN = 2;

const CANDIDATE_MIN = 60;
const CANDIDATE_MAX = 320;
const CANDIDATE_MULTIPLIER = 20;

const CAPABILITY_CACHE_MS = 60_000;
const STOP_SEARCH_TOTAL_BUDGET_MS = Math.max(
  300,
  Number(process.env.STOP_SEARCH_TOTAL_BUDGET_MS || "1800")
);
const STOP_SEARCH_CAPS_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.STOP_SEARCH_CAPS_TIMEOUT_MS || "250")
);
const STOP_SEARCH_PRIMARY_TIMEOUT_MS = Math.max(
  200,
  Number(process.env.STOP_SEARCH_PRIMARY_TIMEOUT_MS || "1100")
);
const STOP_SEARCH_FALLBACK_TIMEOUT_MS = Math.max(
  120,
  Number(process.env.STOP_SEARCH_FALLBACK_TIMEOUT_MS || "900")
);
const STOP_SEARCH_ALIAS_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.STOP_SEARCH_ALIAS_TIMEOUT_MS || "500")
);

const GENERIC_STOP_WORDS = new Set([
  "gare",
  "bahnhof",
  "station",
  "stazione",
  "bahnhofplatz",
]);

const HUB_WORDS = new Set(["hb", "hbf", "hauptbahnhof"]);

let capabilitiesCache = null;
let capabilitiesCacheTs = 0;
const warningKeys = new Set();

function toString(value) {
  if (value == null) return "";
  return String(value);
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  const raw = toString(value).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "t" || raw === "yes";
}

function clampLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(parsed)));
}

function candidateLimitFor(limit) {
  return Math.min(CANDIDATE_MAX, Math.max(CANDIDATE_MIN, limit * CANDIDATE_MULTIPLIER));
}

function buildQueryBackoffVariants(queryNorm) {
  const q = toString(queryNorm).trim();
  if (q.length < MIN_QUERY_LEN + 1) return [];
  const shortened = q.slice(0, -1).trim();
  if (!shortened || shortened.length < MIN_QUERY_LEN || shortened === q) return [];
  return [shortened];
}

function warnOnce(key, message, details = null) {
  if (warningKeys.has(key)) return;
  warningKeys.add(key);
  if (details) {
    console.warn(message, details);
    return;
  }
  console.warn(message);
}

function createBudget(totalMs = STOP_SEARCH_TOTAL_BUDGET_MS) {
  const effective = Math.max(200, Math.trunc(Number(totalMs) || STOP_SEARCH_TOTAL_BUDGET_MS));
  return {
    deadlineMs: Date.now() + effective,
  };
}

function budgetRemainingMs(budget) {
  if (!budget || !Number.isFinite(Number(budget.deadlineMs))) return Number.POSITIVE_INFINITY;
  return Number(budget.deadlineMs) - Date.now();
}

function timeoutWithinBudget({ budget, maxMs, minMs = 80 }) {
  const maxTimeout = Math.max(minMs, Math.trunc(Number(maxMs) || minMs));
  const remaining = budgetRemainingMs(budget);
  if (!Number.isFinite(remaining)) return maxTimeout;
  if (remaining < minMs) return 0;
  return Math.max(minMs, Math.min(maxTimeout, Math.trunc(remaining)));
}

async function runDbQuery(db, sql, params = [], timeoutMs = 0) {
  if (!db || typeof db.query !== "function") {
    throw new Error("stop_search_invalid_db");
  }

  if (typeof db.queryWithTimeout === "function" && Number(timeoutMs) > 0) {
    return db.queryWithTimeout(sql, params, timeoutMs);
  }

  return db.query(sql, params);
}

export function normalizeSearchText(value) {
  return normalizeStopSearchText(value);
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
  return text
    .replace(/,/g, " ")
    .split(" ")
    .filter(Boolean);
}

function splitCommaParts(normalizedText) {
  const raw = toString(normalizedText).trim();
  if (!raw) return [];

  const parts = raw
    .split(",")
    .map((part) => normalizeSearchText(part))
    .filter(Boolean);
  if (parts.length > 0) return parts;

  const normalized = normalizeSearchText(raw);
  return normalized ? [normalized] : [];
}

function hasHubWord(tokens) {
  return tokens.some((token) => HUB_WORDS.has(token));
}

function isParentLike(row) {
  const explicitParent = row?.is_parent;
  if (explicitParent !== undefined && explicitParent !== null) {
    return toBoolean(explicitParent);
  }

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
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
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
  if (a.parentTieRank !== b.parentTieRank) return b.parentTieRank - a.parentTieRank;
  if (a.locationTypeTieRank !== b.locationTypeTieRank) {
    return b.locationTypeTieRank - a.locationTypeTieRank;
  }
  if (a.nbStopTimes !== b.nbStopTimes) return b.nbStopTimes - a.nbStopTimes;
  if (a.nameLength !== b.nameLength) return a.nameLength - b.nameLength;
  const nameCmp = a.stopName.localeCompare(b.stopName, "en", { sensitivity: "base" });
  if (nameCmp !== 0) return nameCmp;
  return a.stopId.localeCompare(b.stopId);
}

function stopNameKey(value) {
  return normalizeSearchText(value) || toString(value).trim().toLowerCase();
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
  const nameParts = splitCommaParts(stopName);
  const candidateHeadTokens = tokenize(nameParts[0] || nameNorm);
  const candidatePostCommaTokens = tokenize(nameParts.slice(1).join(" "));

  const aliasWeight = toFiniteNumber(row?.alias_weight, 0);
  const aliasSimilarity = toFiniteNumber(row?.alias_similarity, 0);
  const nameSimilarity = toFiniteNumber(row?.name_similarity, 0);
  const coreSimilarity = toFiniteNumber(row?.core_similarity, 0);
  const dbSimilarity = Math.max(nameSimilarity, coreSimilarity, aliasSimilarity);

  const exactName =
    nameNorm === queryCtx.queryNorm || (queryCtx.queryCore && coreNorm === queryCtx.queryCore);
  const exactAlias = aliasNorms.some(
    (aliasNorm) =>
      aliasNorm === queryCtx.queryNorm ||
      (queryCtx.queryCore && aliasNorm === queryCtx.queryCore)
  );

  const prefixName =
    nameNorm.startsWith(queryCtx.queryNorm) ||
    (queryCtx.queryCore ? coreNorm.startsWith(queryCtx.queryCore) : false);
  const prefixAlias = aliasNorms.some((aliasNorm) => aliasNorm.startsWith(queryCtx.queryNorm));
  const containsName =
    nameNorm.includes(queryCtx.queryNorm) ||
    (queryCtx.queryCore ? coreNorm.includes(queryCtx.queryCore) : false);
  const containsAlias = aliasNorms.some((aliasNorm) => aliasNorm.includes(queryCtx.queryNorm));

  const startsMatch = wordStartMatch(queryCtx.queryTokens, candidateTokens);
  const tokenContains = tokenContainmentMatch(queryCtx.queryTokens, candidateTokens);
  const postCommaStrongMatch =
    queryCtx.queryPostCommaTokens.length > 0 &&
    tokenContainmentMatch(
      queryCtx.queryPostCommaTokens,
      candidatePostCommaTokens.length > 0 ? candidatePostCommaTokens : candidateTokens
    );
  const postCommaPrefixMatch =
    queryCtx.queryPostCommaTokens.length > 0 &&
    wordStartMatch(
      queryCtx.queryPostCommaTokens,
      candidatePostCommaTokens.length > 0 ? candidatePostCommaTokens : candidateTokens
    );
  const headCityMatch =
    queryCtx.queryHeadTokens.length > 0 &&
    tokenContainmentMatch(queryCtx.queryHeadTokens, candidateHeadTokens);
  const commaStructureMatch = queryCtx.queryHasComma && stopName.includes(",");

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
  else if (containsName || containsAlias || startsMatch) tier = 2;
  else if (fuzzyAccepted) tier = 1;
  else if (tokenContains && fuzzySimilarity >= queryCtx.fuzzyThreshold - 0.08) tier = 1;

  if (tier === 0) return null;

  const parentLike = isParentLike(row);
  const parentPreference =
    queryCtx.queryPostCommaTokens.length > 0
      ? parentLike
        ? -1
        : 1
      : queryCtx.isShortQuery
        ? parentLike
          ? 1
          : -1
        : parentLike
          ? 1
          : 0;

  const cityName = extractCityName(stopName, row?.city_name);
  const cityNorm = normalizeSearchText(cityName);

  const cityMatch =
    !!queryCtx.cityToken &&
    (cityNorm === queryCtx.cityToken ||
      nameNorm.startsWith(`${queryCtx.cityToken} `) ||
      nameNorm === queryCtx.cityToken);

  const hasHubTokenFlag = toBoolean(row?.has_hub_token);
  const candidateHasHubToken =
    hasHubTokenFlag || hasHubWord(candidateTokens) || hasHubWord(nameTokens);

  const nbStopTimes = Math.max(0, Math.round(toFiniteNumber(row?.nb_stop_times, 0)));

  let score = tier * 10_000;
  score += Math.round(fuzzySimilarity * 1000);

  if (exactAlias) score += 1700;
  else if (prefixAlias) score += 900;
  else if (containsAlias) score += 420;

  score += Math.round(aliasWeight * 260);
  score += Math.round(Math.min(nbStopTimes, 120_000) / 250);

  if (cityMatch) score += 220;
  if (cityMatch && parentLike) score += 280;

  if (candidateHasHubToken && cityMatch && !queryCtx.queryHasHubToken) {
    score += 1100;
  } else if (candidateHasHubToken && queryCtx.queryHasHubToken) {
    score += 700;
  }

  if (queryCtx.queryPostCommaTokens.length > 0) {
    if (postCommaStrongMatch) score += 2600;
    if (postCommaPrefixMatch) score += 900;
    if (commaStructureMatch) score += 220;
    if (headCityMatch) score += 180;
    if (parentLike && !postCommaStrongMatch) score -= 1800;
    if (!postCommaStrongMatch && !postCommaPrefixMatch) score -= 1200;
  } else if (queryCtx.isShortQuery) {
    score += parentLike ? 350 : -220;
  } else {
    score += parentLike ? 120 : 0;
  }

  if (tokenContains) score += 120;
  if (startsMatch) score += 180;
  if (containsName) score += 240;

  const parentTieRank = queryCtx.queryPostCommaTokens.length > 0 ? (parentLike ? 0 : 1) : parentLike ? 1 : 0;
  const locationType = toString(row?.location_type).trim();
  const locationTypeTieRank = queryCtx.queryPostCommaTokens.length > 0
    ? locationType === "0" || locationType === "" ? 2 : locationType === "1" ? 1 : 0
    : locationType === "1" ? 2 : locationType === "0" || locationType === "" ? 1 : 0;

  return {
    score,
    tier,
    parentTieRank,
    locationTypeTieRank,
    stopId,
    groupId,
    stopName,
    parentStation: toString(row?.parent_station).trim() || null,
    locationType,
    nameLength: stopName.length,
    nbStopTimes,
    cityName,
    aliasesMatched,
    debugScore: {
      tier,
      fuzzySimilarity: Number(fuzzySimilarity.toFixed(4)),
      exactName,
      exactAlias,
      prefixName,
      prefixAlias,
      containsName,
      containsAlias,
      startsMatch,
      tokenContains,
      cityMatch,
      parentLike,
      parentPreference,
      candidateHasHubToken,
      commaStructureMatch,
      postCommaStrongMatch,
      postCommaPrefixMatch,
      headCityMatch,
      aliasWeight: Number(aliasWeight.toFixed(4)),
      nbStopTimes,
      queryHasHubToken: queryCtx.queryHasHubToken,
      isShortQuery: queryCtx.isShortQuery,
      queryHasComma: queryCtx.queryHasComma,
      queryPostCommaTokens: queryCtx.queryPostCommaTokens,
    },
    isParent: parentLike,
  };
}

export function rankStopCandidatesDetailed(rows, query, limit = DEFAULT_LIMIT) {
  const lim = clampLimit(limit);
  const queryNorm = normalizeSearchText(query);
  if (queryNorm.length < MIN_QUERY_LEN) return [];

  const queryCore = stripStopWords(queryNorm);
  const queryTokens = tokenize(queryCore || queryNorm);
  const queryCommaParts = splitCommaParts(query);
  const queryHasComma = queryCommaParts.length > 1;
  const queryHeadTokens = tokenize(queryCommaParts[0] || queryNorm);
  const queryPostCommaTokens = tokenize(queryCommaParts.slice(1).join(" "));
  const cityToken = queryHeadTokens[0] || queryTokens[0] || "";

  const queryCtx = {
    queryNorm,
    queryCore,
    queryTokens,
    queryHasComma,
    queryHeadTokens,
    queryPostCommaTokens,
    cityToken,
    isShortQuery: queryNorm.length <= 6,
    queryHasHubToken: hasHubWord(queryTokens),
    fuzzyThreshold: similarityThreshold(queryNorm.length),
  };

  const bestByGroupId = new Map();

  for (const row of rows || []) {
    const scored = scoreCandidate(row, queryCtx);
    if (!scored) continue;

    const key = scored.groupId || scored.stopId;
    const previous = bestByGroupId.get(key);
    if (!previous || compareScored(scored, previous) < 0) {
      bestByGroupId.set(key, scored);
    }
  }

  const ordered = Array.from(bestByGroupId.values()).sort(compareScored);
  const uniqueNameRows = [];
  const seenNames = new Set();

  for (const row of ordered) {
    const key = stopNameKey(row.stopName);
    if (!key || !seenNames.has(key)) {
      if (key) seenNames.add(key);
      uniqueNameRows.push(row);
    }
  }
  return uniqueNameRows.slice(0, lim).map((row, index) => ({
    rank: index + 1,
    ...row,
  }));
}

export function rankStopCandidates(rows, query, limit = DEFAULT_LIMIT) {
  const ranked = rankStopCandidatesDetailed(rows, query, limit);
  return ranked.map((row) => {
    const stopId = row.stopId;
    const stationId = row.groupId || row.parentStation || row.stopId;
    const isParent = row.isParent === true;
    const out = {
      id: stopId,
      name: row.stopName,
      stop_id: stopId,
      stationId,
      stationName: row.stopName,
      group_id: stationId,
      raw_stop_id: row.stopId,
      stop_name: row.stopName,
      parent_station: row.parentStation,
      location_type: row.locationType,
      nb_stop_times: row.nbStopTimes,
      city: row.cityName || null,
      canton: null,
      isParent,
      isPlatform: !isParent,
    };

    if (row.aliasesMatched.length > 0) {
      out.aliasesMatched = row.aliasesMatched.slice(0, 5);
    }

    return out;
  });
}

function emptyCapabilities() {
  return {
    hasStopSearchIndex: false,
    hasStopAliases: false,
    hasAppStopAliases: false,
    hasNormalizeFn: false,
    hasStripFn: false,
    hasPgTrgm: false,
    hasUnaccent: false,
  };
}

export function __resetSearchCapabilitiesCacheForTests() {
  capabilitiesCache = null;
  capabilitiesCacheTs = 0;
  warningKeys.clear();
}

export async function detectSearchCapabilities(db, options = {}) {
  const force = options?.force === true;
  if (
    !force &&
    capabilitiesCache &&
    Date.now() - capabilitiesCacheTs <= CAPABILITY_CACHE_MS
  ) {
    return capabilitiesCache;
  }

  let caps = emptyCapabilities();
  try {
    const capsTimeoutMs = timeoutWithinBudget({
      budget: options?.budget,
      maxMs: STOP_SEARCH_CAPS_TIMEOUT_MS,
      minMs: 60,
    });
    if (capsTimeoutMs <= 0) return caps;
    const result = await runDbQuery(
      db,
      `
      SELECT
        to_regclass('public.stop_search_index') IS NOT NULL AS has_stop_search_index,
        to_regclass('public.stop_aliases') IS NOT NULL AS has_stop_aliases,
        to_regclass('public.app_stop_aliases') IS NOT NULL AS has_app_stop_aliases,
        to_regprocedure('public.normalize_stop_search_text(text)') IS NOT NULL AS has_normalize_fn,
        to_regprocedure('public.strip_stop_search_terms(text)') IS NOT NULL AS has_strip_fn,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_pg_trgm,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS has_unaccent
    `,
      [],
      capsTimeoutMs
    );

    const row = result.rows?.[0] || {};
    caps = {
      hasStopSearchIndex: row.has_stop_search_index === true,
      hasStopAliases: row.has_stop_aliases === true,
      hasAppStopAliases: row.has_app_stop_aliases === true,
      hasNormalizeFn: row.has_normalize_fn === true,
      hasStripFn: row.has_strip_fn === true,
      hasPgTrgm: row.has_pg_trgm === true,
      hasUnaccent: row.has_unaccent === true,
    };
  } catch (err) {
    warnOnce("stop_search_caps_probe_error", "[stop-search] capability probe failed; using fallback mode", {
      error: String(err?.message || err),
    });
  }

  capabilitiesCache = caps;
  capabilitiesCacheTs = Date.now();
  return caps;
}

function supportsPrimarySearch(caps) {
  return (
    caps.hasStopSearchIndex &&
    caps.hasStopAliases &&
    caps.hasNormalizeFn &&
    caps.hasStripFn &&
    caps.hasPgTrgm &&
    caps.hasUnaccent
  );
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
    ARRAY_AGG(sa.alias_text ORDER BY sa.weight DESC, sa.alias_text) AS aliases_matched,
    MAX(sa.weight)::float8 AS alias_weight,
    MAX(similarity(sa.alias_norm, p.q_norm))::float8 AS alias_similarity
  FROM public.stop_aliases sa
  CROSS JOIN params p
  WHERE
    p.q_norm <> ''
    AND sa.alias_norm <> ''
    AND (
      sa.alias_norm = p.q_norm
      OR sa.alias_norm LIKE p.q_norm || '%'
      OR sa.alias_norm % p.q_norm
    )
  GROUP BY sa.stop_id
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
  b.is_parent,
  b.has_hub_token,
  b.nb_stop_times,
  COALESCE(ahs.aliases_matched, ahg.aliases_matched, ARRAY[]::text[]) AS aliases_matched,
  GREATEST(COALESCE(ahs.alias_weight, 0), COALESCE(ahg.alias_weight, 0))::float8 AS alias_weight,
  GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0))::float8 AS alias_similarity,
  similarity(b.name_norm, p.q_norm)::float8 AS name_similarity,
  CASE
    WHEN p.q_core = '' THEN 0::float8
    ELSE similarity(b.name_core, p.q_core)::float8
  END AS core_similarity
FROM public.stop_search_index b
CROSS JOIN params p
LEFT JOIN alias_hits ahs ON ahs.stop_id = b.stop_id
LEFT JOIN alias_hits ahg ON ahg.stop_id = b.group_id
WHERE
  p.q_norm <> ''
  AND (
    b.name_norm = p.q_norm
    OR b.name_norm LIKE p.q_norm || '%'
    OR b.search_text LIKE '%' || p.q_norm || '%'
    OR b.search_text % p.q_norm
    OR (p.q_core <> '' AND (b.name_core LIKE p.q_core || '%' OR b.name_core % p.q_core))
    OR GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0)) >= p.sim_threshold
    OR GREATEST(COALESCE(ahs.alias_weight, 0), COALESCE(ahg.alias_weight, 0)) > 0
  )
ORDER BY
  GREATEST(
    CASE WHEN b.name_norm = p.q_norm THEN 1.80 ELSE 0 END,
    CASE WHEN b.name_norm LIKE p.q_norm || '%' THEN 1.35 ELSE 0 END,
    CASE WHEN p.q_core <> '' AND b.name_core LIKE p.q_core || '%' THEN 1.20 ELSE 0 END,
    similarity(b.name_norm, p.q_norm),
    CASE WHEN p.q_core = '' THEN 0 ELSE similarity(b.name_core, p.q_core) END,
    GREATEST(COALESCE(ahs.alias_similarity, 0), COALESCE(ahg.alias_similarity, 0))
  ) DESC,
  b.is_parent DESC,
  b.has_hub_token DESC,
  b.nb_stop_times DESC,
  b.stop_name ASC
LIMIT $2;
`;

const FALLBACK_INDEX_TRGM_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    CASE
      WHEN char_length($1::text) <= 4 THEN 0.48
      WHEN char_length($1::text) <= 6 THEN 0.40
      WHEN char_length($1::text) <= 8 THEN 0.34
      ELSE 0.28
    END AS sim_threshold
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
  ARRAY[]::text[] AS aliases_matched,
  0::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  similarity(b.name_norm, p.q_norm)::float8 AS name_similarity,
  0::float8 AS core_similarity,
  b.is_parent,
  b.has_hub_token,
  b.nb_stop_times
FROM public.stop_search_index b
CROSS JOIN params p
WHERE
  p.q_norm <> ''
  AND (
    b.name_norm = p.q_norm
    OR b.name_norm LIKE p.q_norm || '%'
    OR b.search_text LIKE '%' || p.q_norm || '%'
    OR b.search_text % p.q_norm
  )
ORDER BY
  CASE
    WHEN b.name_norm = p.q_norm THEN 4
    WHEN b.name_norm LIKE p.q_norm || '%' THEN 3
    WHEN b.search_text LIKE '%' || p.q_norm || '%' THEN 2
    ELSE 1
  END DESC,
  similarity(b.name_norm, p.q_norm) DESC,
  b.is_parent DESC,
  b.nb_stop_times DESC,
  b.stop_name ASC
LIMIT $2;
`;

const FALLBACK_INDEX_PLAIN_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    split_part($1::text, ' ', 1) AS q_head,
    left($1::text, 1) AS q_first
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
  ARRAY[]::text[] AS aliases_matched,
  0::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  b.is_parent,
  b.has_hub_token,
  b.nb_stop_times
FROM public.stop_search_index b
CROSS JOIN params p
WHERE
  p.q_norm <> ''
  AND (
    b.name_norm LIKE p.q_norm || '%'
    OR b.search_text LIKE '%' || p.q_norm || '%'
    OR (p.q_head <> '' AND b.name_norm LIKE p.q_head || '%')
    OR (p.q_first <> '' AND b.name_norm LIKE p.q_first || '%')
  )
ORDER BY
  CASE
    WHEN b.name_norm = p.q_norm THEN 4
    WHEN b.name_norm LIKE p.q_norm || '%' THEN 3
    WHEN b.search_text LIKE '%' || p.q_norm || '%' THEN 2
    ELSE 1
  END DESC,
  b.is_parent DESC,
  b.nb_stop_times DESC,
  b.stop_name ASC
LIMIT $2;
`;

const FALLBACK_TRGM_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    trim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')) AS q_fold,
    CASE
      WHEN char_length($1::text) <= 4 THEN 0.48
      WHEN char_length($1::text) <= 6 THEN 0.40
      WHEN char_length($1::text) <= 8 THEN 0.34
      ELSE 0.28
    END AS sim_threshold
),
base AS (
  SELECT
    s.stop_id,
    s.stop_name,
    NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
    COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
    COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
    trim(split_part(s.stop_name, ',', 1)) AS city_name,
    lower(s.stop_name) AS name_lower,
    lower(regexp_replace(s.stop_name, '[-_./''’]+', ' ', 'g')) AS name_simple,
    trim(
      regexp_replace(
        translate(
          lower(s.stop_name),
          'àáâãäåçèéêëìíîïñòóôõöøùúûüýÿ',
          'aaaaaaceeeeiiiinoooooouuuuyy'
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) AS name_fold
  FROM public.gtfs_stops s
),
candidates AS (
  SELECT
    b.*,
    similarity(b.name_fold, p.q_fold)::float8 AS sim_fold,
    CASE
      WHEN b.name_fold = p.q_fold THEN 4
      WHEN b.name_fold LIKE p.q_fold || '%' THEN 3
      WHEN b.name_fold LIKE '%' || p.q_fold || '%' THEN 2
      WHEN b.name_fold % p.q_fold THEN 1
      ELSE 0
    END AS tier
  FROM base b
  CROSS JOIN params p
  WHERE
    p.q_fold <> ''
    AND (
      b.name_fold LIKE p.q_fold || '%'
      OR b.name_fold LIKE '%' || p.q_fold || '%'
      OR b.name_fold % p.q_fold
    )
)
SELECT
  c.group_id,
  c.stop_id,
  c.stop_name,
  c.parent_station,
  c.location_type,
  c.city_name,
  NULL::text AS name_norm,
  NULL::text AS name_core,
  ARRAY[]::text[] AS aliases_matched,
  0::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  c.sim_fold::float8 AS name_similarity,
  0::float8 AS core_similarity,
  (c.parent_station IS NULL OR c.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM candidates c
WHERE c.tier > 0
ORDER BY
  c.tier DESC,
  c.sim_fold DESC,
  (c.parent_station IS NULL OR c.stop_id LIKE 'Parent%') DESC,
  c.stop_name ASC
LIMIT $2;
`;

const FALLBACK_PLAIN_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    trim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')) AS q_fold,
    split_part(trim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')), ' ', 1) AS q_head,
    left(trim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')), 1) AS q_first
),
base AS (
  SELECT
    s.stop_id,
    s.stop_name,
    NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
    COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
    COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
    trim(split_part(s.stop_name, ',', 1)) AS city_name,
    lower(s.stop_name) AS name_lower,
    lower(regexp_replace(s.stop_name, '[-_./''’]+', ' ', 'g')) AS name_simple,
    trim(
      regexp_replace(
        translate(
          lower(s.stop_name),
          'àáâãäåçèéêëìíîïñòóôõöøùúûüýÿ',
          'aaaaaaceeeeiiiinoooooouuuuyy'
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ) AS name_fold
  FROM public.gtfs_stops s
),
candidates AS (
  SELECT
    b.*,
    CASE
      WHEN b.name_fold = p.q_fold THEN 4
      WHEN b.name_fold LIKE p.q_fold || '%' THEN 3
      WHEN b.name_fold LIKE '%' || p.q_fold || '%' THEN 2
      WHEN p.q_head <> '' AND (
        b.name_fold LIKE p.q_head || '%'
      ) THEN 1
      WHEN p.q_first <> '' AND (
        b.name_fold LIKE p.q_first || '%'
      ) THEN 1
      ELSE 0
    END AS tier
  FROM base b
  CROSS JOIN params p
  WHERE
    p.q_fold <> ''
    AND (
      b.name_fold LIKE p.q_fold || '%'
      OR b.name_fold LIKE '%' || p.q_fold || '%'
      OR (
        p.q_head <> ''
        AND (
          b.name_fold LIKE p.q_head || '%'
        )
      )
      OR (
        p.q_first <> ''
        AND (
          b.name_fold LIKE p.q_first || '%'
        )
      )
    )
)
SELECT
  c.group_id,
  c.stop_id,
  c.stop_name,
  c.parent_station,
  c.location_type,
  c.city_name,
  NULL::text AS name_norm,
  NULL::text AS name_core,
  ARRAY[]::text[] AS aliases_matched,
  0::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  (c.parent_station IS NULL OR c.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM candidates c
WHERE c.tier > 0
ORDER BY
  c.tier DESC,
  (c.parent_station IS NULL OR c.stop_id LIKE 'Parent%') DESC,
  c.stop_name ASC
LIMIT $2;
`;

const FALLBACK_STOP_ALIASES_TRGM_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    CASE
      WHEN char_length($1::text) <= 4 THEN 0.48
      WHEN char_length($1::text) <= 6 THEN 0.40
      WHEN char_length($1::text) <= 8 THEN 0.34
      ELSE 0.28
    END AS sim_threshold
)
SELECT
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  ARRAY[sa.alias_text]::text[] AS aliases_matched,
  COALESCE(sa.weight, 1)::float8 AS alias_weight,
  similarity(sa.alias_norm, p.q_norm)::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  (NULLIF(to_jsonb(s) ->> 'parent_station', '') IS NULL OR s.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM public.stop_aliases sa
JOIN public.gtfs_stops s ON s.stop_id = sa.stop_id
CROSS JOIN params p
WHERE
  sa.alias_norm <> ''
  AND p.q_norm <> ''
  AND (
    sa.alias_norm = p.q_norm
    OR sa.alias_norm LIKE p.q_norm || '%'
    OR sa.alias_norm % p.q_norm
  )
ORDER BY
  CASE
    WHEN sa.alias_norm = p.q_norm THEN 4
    WHEN sa.alias_norm LIKE p.q_norm || '%' THEN 3
    WHEN sa.alias_norm % p.q_norm THEN 2
    ELSE 1
  END DESC,
  similarity(sa.alias_norm, p.q_norm) DESC,
  sa.weight DESC,
  sa.alias_text ASC
LIMIT $2;
`;

const FALLBACK_STOP_ALIASES_PLAIN_SQL = `
WITH params AS (
  SELECT $1::text AS q_norm
)
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
  (NULLIF(to_jsonb(s) ->> 'parent_station', '') IS NULL OR s.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM public.stop_aliases sa
JOIN public.gtfs_stops s ON s.stop_id = sa.stop_id
CROSS JOIN params p
WHERE
  p.q_norm <> ''
  AND (
    sa.alias_norm = p.q_norm
    OR sa.alias_norm LIKE p.q_norm || '%'
    OR sa.alias_norm LIKE left(p.q_norm, 1) || '%'
  )
ORDER BY
  CASE
    WHEN sa.alias_norm = p.q_norm THEN 3
    WHEN sa.alias_norm LIKE p.q_norm || '%' THEN 2
    ELSE 1
  END DESC,
  sa.weight DESC,
  sa.alias_text ASC
LIMIT $2;
`;

const FALLBACK_APP_ALIASES_TRGM_SQL = `
WITH params AS (
  SELECT
    $1::text AS q_norm,
    CASE
      WHEN char_length($1::text) <= 4 THEN 0.48
      WHEN char_length($1::text) <= 6 THEN 0.40
      WHEN char_length($1::text) <= 8 THEN 0.34
      ELSE 0.28
    END AS sim_threshold
)
SELECT
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  ARRAY[a.alias]::text[] AS aliases_matched,
  1.20::float8 AS alias_weight,
  similarity(lower(a.alias), p.q_norm)::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  (NULLIF(to_jsonb(s) ->> 'parent_station', '') IS NULL OR s.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM public.app_stop_aliases a
JOIN public.gtfs_stops s ON s.stop_id = a.stop_id
CROSS JOIN params p
WHERE
  p.q_norm <> ''
  AND (
    lower(a.alias) = p.q_norm
    OR lower(a.alias) LIKE p.q_norm || '%'
    OR lower(a.alias) % p.q_norm
  )
ORDER BY
  CASE
    WHEN lower(a.alias) = p.q_norm THEN 4
    WHEN lower(a.alias) LIKE p.q_norm || '%' THEN 3
    WHEN lower(a.alias) % p.q_norm THEN 2
    ELSE 1
  END DESC,
  similarity(lower(a.alias), p.q_norm) DESC,
  a.alias ASC
LIMIT $2;
`;

const FALLBACK_APP_ALIASES_PLAIN_SQL = `
WITH params AS (
  SELECT $1::text AS q_norm
)
SELECT
  COALESCE(NULLIF(to_jsonb(s) ->> 'parent_station', ''), s.stop_id) AS group_id,
  s.stop_id,
  s.stop_name,
  NULLIF(to_jsonb(s) ->> 'parent_station', '') AS parent_station,
  COALESCE(NULLIF(to_jsonb(s) ->> 'location_type', ''), '') AS location_type,
  trim(split_part(s.stop_name, ',', 1)) AS city_name,
  ARRAY[a.alias]::text[] AS aliases_matched,
  1.20::float8 AS alias_weight,
  0::float8 AS alias_similarity,
  0::float8 AS name_similarity,
  0::float8 AS core_similarity,
  (NULLIF(to_jsonb(s) ->> 'parent_station', '') IS NULL OR s.stop_id LIKE 'Parent%') AS is_parent,
  FALSE AS has_hub_token,
  0::int AS nb_stop_times
FROM public.app_stop_aliases a
JOIN public.gtfs_stops s ON s.stop_id = a.stop_id
CROSS JOIN params p
WHERE
  p.q_norm <> ''
  AND (
    lower(a.alias) = p.q_norm
    OR lower(a.alias) LIKE p.q_norm || '%'
    OR lower(a.alias) LIKE left(p.q_norm, 1) || '%'
  )
ORDER BY
  CASE
    WHEN lower(a.alias) = p.q_norm THEN 3
    WHEN lower(a.alias) LIKE p.q_norm || '%' THEN 2
    ELSE 1
  END DESC,
  a.alias ASC
LIMIT $2;
`;

async function fetchPrimaryRows(db, qRaw, candidateLimit, options = {}) {
  const timeoutMs = timeoutWithinBudget({
    budget: options?.budget,
    maxMs: STOP_SEARCH_PRIMARY_TIMEOUT_MS,
    minMs: 120,
  });
  if (timeoutMs <= 0) return [];
  const result = await runDbQuery(db, PRIMARY_SQL, [qRaw, candidateLimit], timeoutMs);
  return result.rows || [];
}

async function fetchFallbackAliasRows(db, queryNorm, candidateLimit, caps, options = {}) {
  const rows = [];
  const forcePrefixOnly = caps.hasUnaccent !== true;

  if (caps.hasStopAliases) {
    const stopAliasTimeoutMs = timeoutWithinBudget({
      budget: options?.budget,
      maxMs: STOP_SEARCH_ALIAS_TIMEOUT_MS,
      minMs: 80,
    });
    if (stopAliasTimeoutMs > 0) {
    const stopAliasSql = !forcePrefixOnly && caps.hasPgTrgm
      ? FALLBACK_STOP_ALIASES_TRGM_SQL
      : FALLBACK_STOP_ALIASES_PLAIN_SQL;
      const stopAliasRes = await runDbQuery(
        db,
        stopAliasSql,
        [queryNorm, candidateLimit],
        stopAliasTimeoutMs
      );
      rows.push(...(stopAliasRes.rows || []));
    }
  }

  if (caps.hasAppStopAliases) {
    const appAliasTimeoutMs = timeoutWithinBudget({
      budget: options?.budget,
      maxMs: STOP_SEARCH_ALIAS_TIMEOUT_MS,
      minMs: 80,
    });
    if (appAliasTimeoutMs > 0) {
    const appAliasSql = !forcePrefixOnly && caps.hasPgTrgm
      ? FALLBACK_APP_ALIASES_TRGM_SQL
      : FALLBACK_APP_ALIASES_PLAIN_SQL;
      const appAliasRes = await runDbQuery(
        db,
        appAliasSql,
        [queryNorm, candidateLimit],
        appAliasTimeoutMs
      );
      rows.push(...(appAliasRes.rows || []));
    }
  }

  return rows;
}

async function runFallbackSearch(db, queryNorm, candidateLimit, caps, options = {}) {
  const forcePrefixOnly = caps.hasUnaccent !== true;
  const useIndexedFallback = caps.hasStopSearchIndex === true;
  const fallbackSql = useIndexedFallback
    ? !forcePrefixOnly && caps.hasPgTrgm
      ? FALLBACK_INDEX_TRGM_SQL
      : FALLBACK_INDEX_PLAIN_SQL
    : !forcePrefixOnly && caps.hasPgTrgm
      ? FALLBACK_TRGM_SQL
      : FALLBACK_PLAIN_SQL;
  const fallbackTimeoutMs = timeoutWithinBudget({
    budget: options?.budget,
    maxMs: STOP_SEARCH_FALLBACK_TIMEOUT_MS,
    minMs: 100,
  });
  if (fallbackTimeoutMs <= 0) return [];
  const baseRes = await runDbQuery(
    db,
    fallbackSql,
    [queryNorm, candidateLimit],
    fallbackTimeoutMs
  );
  const baseRows = baseRes.rows || [];

  let aliasRows = [];
  try {
    aliasRows = await fetchFallbackAliasRows(db, queryNorm, candidateLimit, caps, options);
  } catch (err) {
    warnOnce("stop_search_alias_fallback_error", "[stop-search] alias fallback unavailable", {
      error: String(err?.message || err),
    });
    aliasRows = [];
  }

  return baseRows.concat(aliasRows);
}

async function runStopSearch(db, query, limit = DEFAULT_LIMIT, options = {}) {
  const qRaw = toString(query).trim();
  const qNorm = normalizeSearchText(qRaw);
  if (qNorm.length < MIN_QUERY_LEN) {
    return options?.debug === true ? { stops: [], debug: { queryNorm: qNorm, rows: 0 } } : [];
  }

  const lim = clampLimit(limit);
  const candidateLimit = candidateLimitFor(lim);

  const budget = createBudget(options?.budgetMs);

  const caps = await detectSearchCapabilities(db, { budget });
  const primarySupported = supportsPrimarySearch(caps);

  if (!primarySupported) {
    warnOnce(
      "stop_search_primary_missing_caps",
      "[stop-search] primary path unavailable; using degraded fallback",
      {
        status: "degraded_mode",
        capabilities: caps,
      }
    );
  }

  let rows = [];
  let primaryError = null;

  if (primarySupported) {
    try {
      rows = await fetchPrimaryRows(db, qRaw, candidateLimit, { budget });
    } catch (err) {
      primaryError = err;
      warnOnce("stop_search_primary_error", "[stop-search] primary query failed; falling back", {
        error: String(err?.message || err),
      });
    }
  }

  if (!primarySupported || primaryError || rows.length < Math.min(candidateLimit, lim * 3)) {
    try {
      const fallbackRows = await runFallbackSearch(db, qNorm, candidateLimit, caps, { budget });
      rows = rows.concat(fallbackRows);
    } catch (fallbackErr) {
      if (primaryError) {
        fallbackErr.cause = primaryError;
      }
      throw fallbackErr;
    }
  }

  // Ranking is intentionally simple and stable:
  // prefix/exact > token-contained > fuzzy similarity fallback.
  const ranked = rankStopCandidates(rows, qNorm, lim);
  if (ranked.length > 0 || options?.disableBackoff === true) {
    if (options?.debug !== true) {
      return ranked;
    }

    const rankedDetailed = rankStopCandidatesDetailed(rows, qNorm, lim);
    return {
      stops: ranked,
      debug: {
        query: qRaw,
        queryNorm: qNorm,
        candidateLimit,
        rawRows: rows.length,
        rankedTop: rankedDetailed.slice(0, 10).map((row) => ({
          rank: row.rank,
          stop_id: row.stopId,
          group_id: row.groupId,
          stop_name: row.stopName,
          parent_station: row.parentStation,
          location_type: row.locationType,
          isParent: row.isParent === true,
          score: row.score,
          tier: row.tier,
          score_components: row.debugScore,
        })),
      },
    };
  }

  const backoffVariants = buildQueryBackoffVariants(qNorm);
  for (const backoffQuery of backoffVariants) {
    let retryRows = [];
    try {
      retryRows = await runFallbackSearch(db, backoffQuery, candidateLimit, caps, { budget });
    } catch {
      retryRows = [];
    }
    if (!Array.isArray(retryRows) || retryRows.length === 0) continue;
    const retryRanked = rankStopCandidates(retryRows, backoffQuery, lim);
    if (retryRanked.length === 0) continue;
    if (options?.debug !== true) {
      return retryRanked;
    }
    const retryRankedDetailed = rankStopCandidatesDetailed(retryRows, backoffQuery, lim);
    return {
      stops: retryRanked,
      debug: {
        query: qRaw,
        queryNorm: qNorm,
        queryBackoffNorm: backoffQuery,
        candidateLimit,
        rawRows: retryRows.length,
        rankedTop: retryRankedDetailed.slice(0, 10).map((row) => ({
          rank: row.rank,
          stop_id: row.stopId,
          group_id: row.groupId,
          stop_name: row.stopName,
          parent_station: row.parentStation,
          location_type: row.locationType,
          isParent: row.isParent === true,
          score: row.score,
          tier: row.tier,
          score_components: row.debugScore,
        })),
      },
    };
  }

  if (options?.debug !== true) {
    return [];
  }

  const rankedDetailed = rankStopCandidatesDetailed(rows, qNorm, lim);

  return {
    stops: [],
    debug: {
      query: qRaw,
      queryNorm: qNorm,
      candidateLimit,
      rawRows: rows.length,
      rankedTop: rankedDetailed.slice(0, 10).map((row) => ({
        rank: row.rank,
        stop_id: row.stopId,
        group_id: row.groupId,
        stop_name: row.stopName,
        parent_station: row.parentStation,
        location_type: row.locationType,
        isParent: row.isParent === true,
        score: row.score,
        tier: row.tier,
        score_components: row.debugScore,
      })),
    },
  };
}

export async function searchStops(db, query, limit = DEFAULT_LIMIT) {
  return runStopSearch(db, query, limit);
}

export async function searchStopsWithDebug(db, query, limit = DEFAULT_LIMIT) {
  return runStopSearch(db, query, limit, { debug: true });
}
