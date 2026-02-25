const BACKEND_APP_NAME = "md_backend";
const POLLER_APP_NAME = "md_poller";

function asTrimmedText(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function looksLikePollerEntrypoint(argvEntry) {
  const entry = asTrimmedText(argvEntry);
  if (!entry) return false;
  const normalized = entry.replaceAll("\\", "/");
  return /\/scripts\/poll(Feeds|LaTripUpdates|LaServiceAlerts)\.js$/i.test(normalized);
}

export function resolvePgApplicationName({
  env = process.env,
  argv = process.argv,
} = {}) {
  const explicitName =
    asTrimmedText(env?.PGAPPNAME) || asTrimmedText(env?.PG_APPLICATION_NAME);
  if (explicitName) return explicitName;
  return looksLikePollerEntrypoint(argv?.[1]) ? POLLER_APP_NAME : BACKEND_APP_NAME;
}

export const PG_APPLICATION_NAMES = Object.freeze({
  backend: BACKEND_APP_NAME,
  poller: POLLER_APP_NAME,
});
