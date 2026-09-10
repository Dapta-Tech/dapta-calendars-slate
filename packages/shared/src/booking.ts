/**
 * Is a nav item active for the current path? Exact-match a root href like
 * "/admin" (so it doesn't light up on every sub-route); prefix-match everything
 * else, honouring extra `matches` (e.g. Settings also owns /admin/connections).
 * Pure + framework-agnostic so the shell's active-state logic is unit-testable.
 */
export function isNavItemActive(pathname: string, href: string, matches?: string[]): boolean {
  if (href === '/admin') return pathname === '/admin';
  const targets = matches ?? [href];
  return targets.some((t) => pathname === t || pathname.startsWith(`${t}/`));
}

/**
 * Slot-grouping helpers (ported from the original FE booking util). Slots are
 * absolute UTC instants; regrouping them by the visitor's zone needs no refetch.
 */
import { formatDayHeading, formatMonthLabel, formatSlotTime, weekdayLabels, zonedDayKey } from './time';

/** A slot as returned by the availability API. */
export interface Slot {
  startUtc: string;
  /** Group events (R23): seats left / total. Absent for 1:1 events. */
  spotsLeft?: number;
  capacity?: number;
}

/** A slot rendered for display: the UTC instant plus its label in the visitor's zone. */
export interface DisplaySlot {
  startUtc: string;
  label: string;
  spotsLeft?: number;
  capacity?: number;
}

/** All slots that fall on one calendar day (in the visitor's zone). */
export interface SlotDay {
  dayKey: string;
  heading: string;
  slots: DisplaySlot[];
}

/** How slot labels are rendered. `hour12` is the booking page's 12h/24h toggle. */
export interface SlotDisplayOptions {
  /** BCP-47 tag for the labels. Defaults to 'en-US', as it always has. */
  locale?: string;
  /** true = 12-hour, false = 24-hour, undefined = let the locale decide. */
  hour12?: boolean;
}

/**
 * Group UTC slot instants into day buckets AS SEEN IN `visitorTimeZone`, each
 * slot labelled with its local clock time. Days and slots come back sorted
 * ascending.
 */
export function groupSlotsByDay(
  slots: Slot[],
  visitorTimeZone: string,
  options: SlotDisplayOptions = {},
): SlotDay[] {
  const { locale = 'en-US', hour12 } = options;
  const byDay = new Map<string, DisplaySlot[]>();
  for (const slot of slots) {
    const dayKey = zonedDayKey(slot.startUtc, visitorTimeZone);
    const display: DisplaySlot = {
      startUtc: slot.startUtc,
      label: formatSlotTime(slot.startUtc, visitorTimeZone, locale, hour12),
      spotsLeft: slot.spotsLeft,
      capacity: slot.capacity,
    };
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(display);
    else byDay.set(dayKey, [display]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dayKey, daySlots]) => ({
      dayKey,
      heading: formatDayHeading(daySlots[0]!.startUtc, visitorTimeZone, locale),
      slots: daySlots.sort((a, b) =>
        a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0,
      ),
    }));
}

/* ---------------------------------------------------------------------------
 * Month calendar (BP). Everything below works on DAY KEYS — 'YYYY-MM-DD'
 * strings already resolved in the visitor's zone by `zonedDayKey` — never on
 * `Date` objects in local time. That is the whole reason it is pure and
 * testable: the one timezone-sensitive step (instant -> zoned day) happens
 * once, above, and the grid is calendar arithmetic on strings after that.
 * ------------------------------------------------------------------------ */

/** One cell of the month grid. */
export interface CalendarDay {
  /** 'YYYY-MM-DD' in the visitor's zone. */
  dayKey: string;
  /** 1..31, for the label. */
  dayOfMonth: number;
  /**
   * The spoken date ("Monday, September 14") for the cell's accessible name —
   * the visible label is a bare number, which is not a date. Built here rather
   * than in the component because this function already owns the day loop and
   * can share ONE `Intl.DateTimeFormat` across all 42 cells.
   */
  label: string;
  /** False for the leading/trailing cells borrowed from the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** Strictly before today in the visitor's zone. */
  isPast: boolean;
  /** At least one bookable slot falls on this day. */
  hasSlots: boolean;
}

/** A month laid out as whole weeks, ready to render. */
export interface CalendarMonth {
  /** 'YYYY-MM'. */
  monthKey: string;
  /** 'September 2026'. */
  label: string;
  /** Seven column headers, already rotated to the locale's first weekday. */
  weekdayLabels: string[];
  weeks: CalendarDay[][];
}

/** The 'YYYY-MM' a day key belongs to. */
export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** Move a 'YYYY-MM' key by whole months, rolling the year over. */
export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  // Month index is 0-based here so negative and >11 values roll naturally.
  const i = year! * 12 + (month! - 1) + delta;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((((i % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

/** The 'YYYY-MM-DD' `days` days after `dayKey`. Pure UTC math — no zone involved. */
function addDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * Lay a month out as whole weeks, marking which days can be booked.
 *
 * `availableDayKeys` is normally the set of `dayKey`s from `groupSlotsByDay`,
 * so the calendar and the day column can never disagree about which days have
 * times — they are two readings of one list, not two queries.
 */
export function buildMonthGrid(
  monthKey: string,
  options: {
    availableDayKeys: Iterable<string>;
    /** Today in the VISITOR's zone (`zonedTodayKey`), not the server's. */
    todayKey: string;
    locale?: string;
    /** 0 = Sunday (default), 1 = Monday. */
    weekStartsOn?: number;
  },
): CalendarMonth {
  const { availableDayKeys, todayKey, locale = 'en-US', weekStartsOn = 0 } = options;
  const available = availableDayKeys instanceof Set ? availableDayKeys : new Set(availableDayKeys);

  const [year, month] = monthKey.split('-').map(Number);
  const first = `${monthKey}-01`;
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year!, month! - 1, 1)).getUTCDay();
  // How many trailing days of the previous month the first row has to borrow.
  const lead = (firstWeekday - weekStartsOn + 7) % 7;
  // Whole weeks only, so every row has seven cells and the grid never ragged-ends.
  const cellCount = Math.ceil((lead + daysInMonth) / 7) * 7;

  // One formatter for the whole grid. Constructing an `Intl.DateTimeFormat`
  // per cell costs 42 of them on every render — every day pick, every month
  // step, every timezone switch.
  const spoken = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < cellCount; i++) {
    const dayKey = addDays(first, i - lead);
    const [dy, dm, dd] = dayKey.split('-').map(Number);
    const day: CalendarDay = {
      dayKey,
      dayOfMonth: Number(dayKey.slice(8)),
      // Noon, so no zone can shift the label onto the neighbouring day.
      label: spoken.format(new Date(Date.UTC(dy!, dm! - 1, dd!, 12))),
      inMonth: monthKeyOf(dayKey) === monthKey,
      isToday: dayKey === todayKey,
      isPast: dayKey < todayKey,
      hasSlots: available.has(dayKey),
    };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push(day);
  }

  return {
    monthKey,
    label: formatMonthLabel(monthKey, locale),
    weekdayLabels: weekdayLabels(locale, weekStartsOn),
    weeks,
  };
}
