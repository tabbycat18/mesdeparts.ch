const ZURICH_TIME_ZONE = "Europe/Zurich";

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZURICH_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ZURICH_TIME_ZONE,
  weekday: "short",
});

const OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ZURICH_TIME_ZONE,
  timeZoneName: "shortOffset",
});

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return new Date();
}

function zonedParts(date) {
  const parts = PARTS_FORMATTER.formatToParts(asDate(date));
  const read = (type) => parts.find((item) => item.type === type)?.value || "";
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  const second = Number(read("second"));
  const normalizedHour = Number.isFinite(hour) ? hour % 24 : 0;
  return {
    year: Number.isFinite(year) ? year : 1970,
    month: Number.isFinite(month) ? month : 1,
    day: Number.isFinite(day) ? day : 1,
    hour: normalizedHour,
    minute: Number.isFinite(minute) ? minute : 0,
    second: Number.isFinite(second) ? second : 0,
  };
}

function tzOffsetMinutesForDate(date) {
  const parts = OFFSET_FORMATTER.formatToParts(asDate(date));
  const raw = parts.find((item) => item.type === "timeZoneName")?.value || "GMT+0";
  const m = raw.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2] || "0");
  const mm = Number(m[3] || "0");
  const total = hh * 60 + mm;
  return sign * total;
}

function ymdPartsFromInt(ymdInt) {
  const raw = String(ymdInt || "").trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function pad2(n) {
  return String(Math.max(0, Math.trunc(Number(n) || 0))).padStart(2, "0");
}

export function formatZurich(date) {
  const p = zonedParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(
    p.second
  )} Europe/Zurich`;
}

export function secondsSinceZurichMidnight(date) {
  const p = zonedParts(date);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

export function ymdIntInZurich(date) {
  const p = zonedParts(date);
  return p.year * 10000 + p.month * 100 + p.day;
}

export function weekdayIndexInZurich(date) {
  const wk = WEEKDAY_FORMATTER.format(asDate(date));
  return Number.isFinite(WEEKDAY_INDEX[wk]) ? WEEKDAY_INDEX[wk] : 0;
}

export function addDaysToYmdInt(ymdInt, days) {
  const p = ymdPartsFromInt(ymdInt);
  if (!p) return ymdInt;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + Math.trunc(Number(days) || 0));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function zurichDateTimeToUtcDate({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
}) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 6; i += 1) {
    const actual = zonedParts(new Date(guess));
    const desiredUtcLike = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualUtcLike = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const delta = desiredUtcLike - actualUtcLike;
    if (Math.abs(delta) < 1000) break;
    guess += delta;
  }

  const approxOffsetMinutes = tzOffsetMinutesForDate(new Date(guess));
  const adjusted = Date.UTC(year, month - 1, day, hour, minute, second) - approxOffsetMinutes * 60000;
  return new Date(adjusted);
}

export function dateFromZurichServiceDateAndSeconds(serviceDateInt, seconds) {
  const dateParts = ymdPartsFromInt(serviceDateInt);
  if (!dateParts) return null;
  if (!Number.isFinite(seconds)) return null;

  const sec = Math.trunc(seconds);
  const dayOffset = Math.floor(sec / 86400);
  const secOfDay = ((sec % 86400) + 86400) % 86400;

  const base = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + dayOffset);

  const h = Math.floor(secOfDay / 3600);
  const m = Math.floor((secOfDay % 3600) / 60);
  const s = secOfDay % 60;

  return zurichDateTimeToUtcDate({
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour: h,
    minute: m,
    second: s,
  });
}

export function dateFromZurichServiceDateAndTime(serviceDateInt, timeStr) {
  const dateParts = ymdPartsFromInt(serviceDateInt);
  if (!dateParts) return null;
  const parts = String(timeStr || "").trim().split(":");
  if (parts.length < 2) return null;
  const hh = Number(parts[0] || "0");
  const mm = Number(parts[1] || "0");
  const ss = Number(parts[2] || "0");
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  const seconds = hh * 3600 + mm * 60 + ss;
  return dateFromZurichServiceDateAndSeconds(serviceDateInt, seconds);
}

export function zonedWindowDebug({ now, lookbackMinutes, windowMinutes }) {
  const nowDate = asDate(now);
  const lookbackMs = Math.max(0, Number(lookbackMinutes) || 0) * 60 * 1000;
  const windowMs = Math.max(1, Number(windowMinutes) || 120) * 60 * 1000;
  const start = new Date(nowDate.getTime() - lookbackMs);
  const end = new Date(nowDate.getTime() + windowMs);
  return {
    now: {
      utc: nowDate.toISOString(),
      zurich: formatZurich(nowDate),
    },
    start: {
      utc: start.toISOString(),
      zurich: formatZurich(start),
    },
    end: {
      utc: end.toISOString(),
      zurich: formatZurich(end),
    },
  };
}

export { ZURICH_TIME_ZONE };
