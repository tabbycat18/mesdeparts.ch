function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeAliasKey(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

const RESOLVE_STOP_CACHE_MS = Math.max(
  1_000,
  Number(process.env.RESOLVE_STOP_CACHE_MS || "300000")
);
const RESOLVE_STOP_CACHE_MAX = Math.max(
  100,
  Number(process.env.RESOLVE_STOP_CACHE_MAX || "5000")
);
const resolveCache = new Map();

function resolveCacheKey({ stopId, stationId, stationName }) {
  return `${normalizeText(stopId)}|${normalizeText(stationId)}|${normalizeAliasKey(stationName)}`;
}

function cloneResolution(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    canonical: value.canonical ? { ...value.canonical } : value.canonical,
    children: Array.isArray(value.children)
      ? value.children.map((child) => ({ ...child }))
      : [],
    tried: Array.isArray(value.tried) ? [...value.tried] : [],
  };
}

function getResolveCacheEntry(key) {
  const entry = resolveCache.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.ts || 0) > RESOLVE_STOP_CACHE_MS) {
    resolveCache.delete(key);
    return null;
  }
  return cloneResolution(entry.value);
}

function setResolveCacheEntry(key, value) {
  resolveCache.set(key, { ts: Date.now(), value: cloneResolution(value) });
  if (resolveCache.size <= RESOLVE_STOP_CACHE_MAX) return;
  const oldestKey = resolveCache.keys().next().value;
  if (oldestKey) resolveCache.delete(oldestKey);
}

function isNumericLike(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function isParentIdLike(value) {
  return /^parent/i.test(normalizeText(value));
}

function isPlatformLike(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return text.includes(":");
}

function stopKindFromRow(row, { hasChildren = false } = {}) {
  const stopId = normalizeText(row?.stop_id);
  const parentStation = normalizeText(row?.parent_station);
  const locationType = normalizeText(row?.location_type);
  const platformCode = normalizeText(row?.platform_code);

  if (hasChildren) return "parent";
  if (stopId.startsWith("Parent")) return "parent";
  if (locationType === "1") return "parent";
  if (parentStation) return "platform";
  if (platformCode) return "platform";
  if (stopId.includes(":")) return "platform";
  return "stop";
}

function toChildShape(row) {
  return {
    id: normalizeText(row?.stop_id),
    platform_code: normalizeText(row?.platform_code),
    name: normalizeText(row?.stop_name) || normalizeText(row?.stop_id),
    kind: stopKindFromRow(row),
  };
}

async function getStopById(db, stopId) {
  const id = normalizeText(stopId);
  if (!id) return null;
  const res = await db.query(
    `
    SELECT
      s.stop_id,
      s.stop_name,
      ''::text AS location_type,
      s.parent_station,
      s.platform_code
    FROM public.gtfs_stops s
    WHERE s.stop_id = $1
    LIMIT 1
    `,
    [id]
  );
  return res.rows?.[0] || null;
}

async function getChildrenByParentId(db, parentId) {
  const id = normalizeText(parentId);
  if (!id) return [];
  const res = await db.query(
    `
    SELECT
      s.stop_id,
      s.stop_name,
      ''::text AS location_type,
      s.parent_station,
      s.platform_code
    FROM public.gtfs_stops s
    WHERE s.parent_station = $1
    ORDER BY NULLIF(s.platform_code, '') NULLS LAST, s.stop_id
    `,
    [id]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

async function getAnyChildByParentId(db, parentId) {
  const id = normalizeText(parentId);
  if (!id) return null;
  const res = await db.query(
    `
    SELECT
      s.stop_id,
      s.stop_name,
      ''::text AS location_type,
      s.parent_station,
      s.platform_code
    FROM public.gtfs_stops s
    WHERE s.parent_station = $1
    LIMIT 1
    `,
    [id]
  );
  return res.rows?.[0] || null;
}

async function getParentForChildLikeInput(db, childLikeId) {
  const raw = normalizeText(childLikeId);
  if (!raw) return null;
  const res = await db.query(
    `
    SELECT
      p.stop_id,
      p.stop_name,
      ''::text AS location_type,
      p.parent_station,
      p.platform_code
    FROM public.gtfs_stops c
    JOIN public.gtfs_stops p ON p.stop_id = c.parent_station
    WHERE c.stop_id = $1 OR c.stop_id LIKE $1 || ':%'
    ORDER BY
      CASE WHEN c.stop_id = $1 THEN 0 ELSE 1 END,
      char_length(c.stop_id) ASC
    LIMIT 1
    `,
    [raw]
  );
  return res.rows?.[0] || null;
}

async function hasChildrenForParent(db, parentId) {
  const id = normalizeText(parentId);
  if (!id) return false;
  const res = await db.query(
    `
    SELECT 1 AS ok
    FROM public.gtfs_stops s
    WHERE s.parent_station = $1
    LIMIT 1
    `,
    [id]
  );
  return (res.rows?.length || 0) > 0;
}

async function lookupAliasTarget(db, aliasKeys) {
  const keys = unique(aliasKeys.map(normalizeText));
  if (keys.length === 0) return null;

  const normalizedKeys = unique(keys.map(normalizeAliasKey).filter(Boolean));

  const exactRes = await db.query(
    `
    SELECT a.stop_id
    FROM public.app_stop_aliases a
    WHERE a.alias = ANY($1::text[])
    LIMIT 1
    `,
    [keys]
  );
  if ((exactRes.rows?.length || 0) > 0) {
    return normalizeText(exactRes.rows[0]?.stop_id);
  }

  if (normalizedKeys.length === 0) return null;
  const normalizedRes = await db.query(
    `
    SELECT a.stop_id
    FROM public.app_stop_aliases a
    WHERE LOWER(a.alias) = ANY($1::text[])
    LIMIT 1
    `,
    [normalizedKeys]
  );
  if ((normalizedRes.rows?.length || 0) > 0) {
    return normalizeText(normalizedRes.rows[0]?.stop_id);
  }

  return null;
}

async function resolveCandidateStop(db, candidate) {
  const raw = normalizeText(candidate);
  if (!raw) return null;

  const tried = unique([raw, !isParentIdLike(raw) && isNumericLike(raw) ? `Parent${raw}` : ""].map(normalizeText));

  for (const key of tried) {
    const stop = await getStopById(db, key);
    if (stop) return stop;
  }

  if (isParentIdLike(raw)) {
    return null;
  }

  if (isPlatformLike(raw)) {
    const parent = await getParentForChildLikeInput(db, raw);
    if (parent) return parent;
  }

  // Some stations can be addressed by parent_station value without a dedicated
  // parent row in gtfs_stops; synthesize a parent-like stop from a child.
  if (isNumericLike(raw)) {
    const child = await getAnyChildByParentId(db, raw);
    if (child) {
      return {
        stop_id: raw,
        stop_name: normalizeText(child.stop_name) || raw,
        location_type: "1",
        parent_station: "",
        platform_code: "",
      };
    }
  }

  return null;
}

async function finalizeResolution(db, stopRow) {
  const sourceStop = stopRow || {};
  const sourceStopId = normalizeText(sourceStop.stop_id);
  const sourceParent = normalizeText(sourceStop.parent_station);

  let canonicalRow = sourceStop;
  if (sourceParent) {
    const parentRow = await getStopById(db, sourceParent);
    if (parentRow) {
      canonicalRow = parentRow;
    }
  } else if (!sourceStopId.startsWith("Parent") && isNumericLike(sourceStopId)) {
    const parentPrefixed = await getStopById(db, `Parent${sourceStopId}`);
    if (parentPrefixed) {
      canonicalRow = parentPrefixed;
    }
  }

  let canonicalId = normalizeText(canonicalRow?.stop_id);
  let childrenRows = [];

  const canonicalIsParentLike =
    normalizeText(canonicalRow?.parent_station) === "" &&
    (canonicalId.startsWith("Parent") ||
      normalizeText(canonicalRow?.location_type) === "1" ||
      (await hasChildrenForParent(db, canonicalId)));

  if (canonicalIsParentLike) {
    const candidates = unique([
      canonicalId,
      canonicalId.startsWith("Parent") ? canonicalId.slice("Parent".length) : "",
    ]);
    for (const candidate of candidates) {
      const rows = await getChildrenByParentId(db, candidate);
      if (rows.length > 0) {
        childrenRows = rows;
        break;
      }
    }
  }

  if (childrenRows.length === 0) {
    if (sourceParent && !canonicalId) {
      canonicalId = sourceParent;
    }
    const fallback = sourceStopId && sourceStopId !== canonicalId ? sourceStop : canonicalRow;
    if (fallback && normalizeText(fallback.stop_id)) {
      childrenRows = [fallback];
    }
  }

  const children = unique(childrenRows.map((row) => normalizeText(row?.stop_id)))
    .map((id) => childrenRows.find((row) => normalizeText(row?.stop_id) === id))
    .filter(Boolean)
    .map(toChildShape);

  let canonicalHasChildren = canonicalIsParentLike;
  if (!canonicalHasChildren && canonicalId) {
    canonicalHasChildren = await hasChildrenForParent(db, canonicalId).catch(
      () => false
    );
  }

  const canonical = {
    id: canonicalId || sourceStopId,
    name:
      normalizeText(canonicalRow?.stop_name) ||
      normalizeText(sourceStop?.stop_name) ||
      canonicalId ||
      sourceStopId,
    kind: stopKindFromRow(canonicalRow, {
      hasChildren: canonicalHasChildren,
    }),
  };

  if (canonical.kind !== "parent" && canonicalHasChildren && canonical.id) {
    const parentLike = await hasChildrenForParent(db, canonical.id).catch(() => false);
    if (parentLike) canonical.kind = "parent";
  }

  if (!canonical.id) return null;

  return {
    canonical,
    children,
    displayName: canonical.name,
  };
}

export async function resolveStop(
  { stop_id: rawStopId, stationId: rawStationId, stationName: rawStationName } = {},
  { db } = {}
) {
  if (!db || typeof db.query !== "function") {
    throw new Error("resolveStop requires a db client with query(sql, params)");
  }

  const stopId = normalizeText(rawStopId);
  const stationId = normalizeText(rawStationId);
  const stationName = normalizeText(rawStationName);
  const cacheKey = resolveCacheKey({ stopId, stationId, stationName });
  const cached = getResolveCacheEntry(cacheKey);
  if (cached) return cached;

  const directCandidates = unique([stopId, stationId]);
  const tried = [];
  const pushTried = (value) => {
    const v = normalizeText(value);
    if (!v || tried.includes(v)) return;
    tried.push(v);
  };

  for (const candidate of directCandidates) {
    pushTried(candidate);
    const directStop = await resolveCandidateStop(db, candidate);
    if (!directStop) continue;
    const resolved = await finalizeResolution(db, directStop);
    if (!resolved) continue;
    const out = {
      ...resolved,
      source: "direct",
      tried,
    };
    setResolveCacheEntry(cacheKey, out);
    return out;
  }

  const aliasCandidates = unique(
    [stopId, stationId, stationName]
      .map(normalizeText)
      .filter(Boolean)
      .flatMap((value) => [value, normalizeAliasKey(value)])
      .map(normalizeText)
      .filter(Boolean)
  );
  aliasCandidates.forEach(pushTried);

  const aliasTarget = await lookupAliasTarget(db, aliasCandidates);
  if (aliasTarget) {
    pushTried(`alias:${aliasTarget}`);
    const aliasStop = await resolveCandidateStop(db, aliasTarget);
    if (aliasStop) {
      const resolved = await finalizeResolution(db, aliasStop);
      if (resolved) {
        const out = {
          ...resolved,
          source: "alias",
          tried,
        };
        setResolveCacheEntry(cacheKey, out);
        return out;
      }
    }
  }

  // Last DB fallback on direct ids only (no free-text stop_name matching).
  for (const candidate of directCandidates) {
    if (!candidate) continue;
    const row = await getStopById(db, candidate);
    if (!row) continue;
    const resolved = await finalizeResolution(db, row);
    if (!resolved) continue;
    const out = {
      ...resolved,
      source: "db",
      tried,
    };
    setResolveCacheEntry(cacheKey, out);
    return out;
  }

  const err = new Error("unknown_stop");
  err.code = "stop_not_found";
  err.status = 404;
  err.tried = tried;
  err.details = {
    reason: isParentIdLike(stopId || stationId)
      ? "parent_stop_id_not_found_in_static_db"
      : "stop_id_not_found_in_static_db",
    requestedStopId: stopId || stationId || null,
    requestedStationName: stationName || null,
  };
  throw err;
}
