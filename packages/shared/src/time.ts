/**
 * Timezone helpers for the booking surface (ported from the original FE utils).
 * All slot instants cross the wire as ISO-8601 UTC; the UI renders them in the
 * visitor's chosen IANA zone. Dependency-free — leans on `Intl.DateTimeFormat`
 * so DST transitions are honored by the platform's IANA database.
 */

/** The visitor's own IANA zone, with a safe fallback when the platform hides it. */
export function detectTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Offset (minutes, east-of-UTC positive) of `instant` in `timeZone`. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Format a UTC instant as the clock time ("9:00 AM" / "09:00") shown in
 * `timeZone`.
 *
 * `hour12` is the booking page's 12h/24h toggle (BP). Left undefined the
 * locale decides, which is what every caller predating the toggle wants. It is
 * a PARAMETER rather than a second formatter on purpose: one code path means
 * the DST behaviour the platform's IANA database gives us cannot drift between
 * the two views of the same slot.
 */
export function formatSlotTime(
  utcIso: string,
  timeZone: string,
  locale = 'en-US',
  hour12?: boolean,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    // `hourCycle` rather than a bare `hour12: false`, which renders midnight as
    // "24:00" on several locales. h23 is the 00–23 clock people mean by "24h".
    ...(hour12 === undefined ? {} : hour12 ? { hour12: true } : { hourCycle: 'h23' as const }),
  }).format(new Date(utcIso));
}

/** Format a UTC instant as a full, human date+time in `timeZone`. */
export function formatSlotDateTime(
  utcIso: string,
  timeZone: string,
  locale = 'en-US',
  hour12?: boolean,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(hour12 === undefined ? {} : hour12 ? { hour12: true } : { hourCycle: 'h23' as const }),
  }).format(new Date(utcIso));
}

/** The calendar day ("2026-07-06") a UTC instant falls on when viewed in `timeZone`. */
export function zonedDayKey(utcIso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcIso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A human day heading ("Mon, Jul 6") for a slot's zoned day. */
export function formatDayHeading(utcIso: string, timeZone: string, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(utcIso));
}

/**
 * The calendar day ("2026-07-06") it is RIGHT NOW in `timeZone`. The month
 * calendar marks "today" from the visitor's zone, not the server's — a booker
 * in Tokyo reading a page rendered in New York must not be shown yesterday.
 */
export function zonedTodayKey(timeZone: string, now: Date = new Date()): string {
  return zonedDayKey(now.toISOString(), timeZone);
}

/**
 * A day key ("2026-09-14") as a full spoken date ("Monday, September 14").
 * The calendar's cells show a bare number; this is what their accessible name
 * has to say, because "14" out of context is not a date.
 */
export function formatDayKeyLong(dayKey: string, locale = 'en-US'): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y!, m! - 1, d!, 12)));
}

/**
 * Month-and-year heading ("September 2026") for a `YYYY-MM` key.
 *
 * Formatted at UTC noon of the first: midnight would fall on the previous day
 * in every zone west of Greenwich and label the month before it. The zone is
 * pinned to UTC for the same reason — a month name is a property of the key,
 * not of where the reader is standing.
 */
export function formatMonthLabel(monthKey: string, locale = 'en-US'): string {
  const [year, month] = monthKey.split('-').map(Number);
  const label = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year!, month! - 1, 1, 12)));
  // Spanish renders "septiembre de 2026" lowercase; a heading reads better
  // capitalized, and every locale we ship is fine with an initial capital.
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The seven weekday column headers, starting at `weekStartsOn` (0 = Sunday).
 * `format` picks the width: 'narrow' is the single letter a 46px column can
 * hold, 'short' the three-letter form a wide grid can afford.
 */
export function weekdayLabels(
  locale = 'en-US',
  weekStartsOn = 0,
  format: 'narrow' | 'short' = 'narrow',
): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: format });
  // 2024-01-07 was a Sunday; adding the index walks one full week.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(Date.UTC(2024, 0, 7 + ((weekStartsOn + i) % 7), 12))),
  );
}

/** Which weekday a locale's calendar starts on — Monday in Spanish, Sunday in English. */
export function weekStartsOnFor(locale: string): number {
  return locale.toLowerCase().startsWith('es') ? 1 : 0;
}

/**
 * Whether `tz` is a usable IANA timezone on this runtime. The probe is the
 * platform's own `Intl` database (not `supportedValuesOf`, which omits
 * aliases like `US/Eastern` that format perfectly well) — if a formatter can
 * be constructed, every render/engine path can use the zone safely.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A timezone that is always safe to hand to `Intl.DateTimeFormat`: the stored
 * value when valid, `UTC` otherwise. Render paths use this so one corrupt row
 * can never crash a whole page (write paths reject invalid zones, but the DB
 * may already hold bad data from before validation existed).
 */
export function safeTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : 'UTC';
}

/** A curated, deduplicated list of common IANA zones, always including `includeZone`. */
export function commonTimeZones(includeZone?: string): string[] {
  const withValues = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[];
  if (typeof withValues.supportedValuesOf === 'function') {
    zones = withValues.supportedValuesOf('timeZone');
  } else {
    zones = CURATED_ZONES.slice();
  }
  if (includeZone && !zones.includes(includeZone)) {
    zones = [includeZone, ...zones];
  }
  return zones;
}

const CURATED_ZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];
