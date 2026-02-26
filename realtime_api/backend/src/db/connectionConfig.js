import { PG_APPLICATION_NAMES } from "./applicationName.js";

function asTrimmedText(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

export function resolveDatabaseConnection({
  env = process.env,
  applicationName,
} = {}) {
  const appName = asTrimmedText(applicationName);
  const databaseUrl = asTrimmedText(env?.DATABASE_URL);
  const pollerDatabaseUrl = asTrimmedText(env?.DATABASE_URL_POLLER);

  if (appName === PG_APPLICATION_NAMES.poller && pollerDatabaseUrl) {
    return {
      connectionString: pollerDatabaseUrl,
      source: "DATABASE_URL_POLLER",
    };
  }

  return {
    connectionString: databaseUrl,
    source: databaseUrl ? "DATABASE_URL" : null,
  };
}
