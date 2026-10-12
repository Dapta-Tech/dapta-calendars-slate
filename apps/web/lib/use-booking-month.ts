'use client';

import { useMemo, useState } from 'react';
import { groupSlotsByDay, monthKeyOf, zonedTodayKey, type Slot } from '@slate/shared';

/**
 * The month a booking surface shows and the day whose times are on screen,
 * derived from the times it was given.
 *
 * Lifted out of `BookingFlow` unchanged so the manage page's reschedule picker
 * reads its month exactly the way the event page does: the same bounds, the
 * same fallback day, the same behaviour across a time zone switch.
 */
export function useBookingMonth({
  slots,
  timeZone,
  locale,
  hour12,
  nowUtc,
  lastMonthKey,
}: {
  slots: Slot[];
  timeZone: string;
  locale: string;
  hour12: boolean;
  /** The instant "today" is read from; see `BookingFlow`'s `nowUtc`. */
  nowUtc: string;
  /**
   * The last month the visitor may go to, when the page cannot read it off the
   * times because it does not have them all yet (the event page reads a month
   * at a time). Omitted, it is the month of the last time the page holds.
   */
  lastMonthKey?: string;
}) {
  /**
   * The month the visitor has navigated to, or `null` for "wherever the times
   * start". Held as the NAVIGATION rather than as the answer, because the
   * answer also depends on the timezone: switching zones can move today across
   * a month boundary, and a month pinned at mount would then sit outside its
   * own bounds with both arrows pointing away from it.
   */
  const [navMonth, setNavMonth] = useState<string | null>(null);
  /** The day the visitor explicitly picked; `null` means "use the default". */
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  const days = useMemo(
    () => groupSlotsByDay(slots, timeZone, { locale, hour12 }),
    [slots, timeZone, locale, hour12],
  );

  /**
   * Everything the calendar needs, derived from the SAME day buckets the
   * column renders. Two readings of one list, so the grid can never offer a
   * day the column then has nothing for, which is the classic way a booking
   * calendar lies to someone.
   */
  const { dayMap, availableDayKeys, todayKey, minMonth, maxMonth, firstMonth } = useMemo(() => {
    const map = new Map(days.map((d) => [d.dayKey, d]));
    const today = zonedTodayKey(timeZone, new Date(nowUtc));
    const last = days.length ? days[days.length - 1]!.dayKey : today;
    const first = days.length ? days[0]!.dayKey : today;
    const min = monthKeyOf(today);
    return {
      dayMap: map,
      availableDayKeys: new Set(map.keys()),
      todayKey: today,
      // No previous month before the one holding today, and no next month past
      // the last day the page actually has a slot for. A visitor is never sent
      // to a month this page has no answer for.
      minMonth: min,
      maxMonth: lastMonthKey ?? monthKeyOf(last < today ? today : last),
      // Open on the month the times actually start in. A host fully booked
      // this month, or whose availability begins next month, would otherwise
      // open on a grid of greyed-out days with nothing saying that "next" is
      // the answer.
      firstMonth: monthKeyOf(first) < min ? min : monthKeyOf(first),
    };
  }, [days, timeZone, nowUtc, lastMonthKey]);

  /**
   * The month on screen: the visitor's navigation, clamped into the bounds the
   * data actually supports, falling back to the first month with times in it.
   */
  const month = useMemo(() => {
    const wanted = navMonth ?? firstMonth;
    return wanted < minMonth ? minMonth : wanted > maxMonth ? maxMonth : wanted;
  }, [navMonth, firstMonth, minMonth, maxMonth]);

  /**
   * The day whose times are on screen. `pickedDay` is only the visitor's
   * explicit choice; when it does not survive a timezone switch (the day keys
   * move) or a month change, this falls back to the first bookable day in the
   * month being viewed. Deriving it instead of syncing it in an effect is what
   * keeps a tz switch from blanking the column for a frame.
   */
  const selectedDay = useMemo(() => {
    if (pickedDay && dayMap.has(pickedDay) && monthKeyOf(pickedDay) === month) return pickedDay;
    return days.find((d) => monthKeyOf(d.dayKey) === month)?.dayKey ?? null;
  }, [pickedDay, dayMap, days, month]);

  const dayColumn = selectedDay ? (dayMap.get(selectedDay) ?? null) : null;

  /**
   * The first day after the one on screen that has times, in any month. A
   * short day ends its list with a quiet way to it rather than with empty
   * space (or filler) under three chips.
   */
  const nextDay = useMemo(() => {
    if (!selectedDay) return null;
    return days.find((d) => d.dayKey > selectedDay) ?? null;
  }, [days, selectedDay]);

  /** Show a given day: its month, and that day's times. */
  const goToDay = (dayKey: string) => {
    setNavMonth(monthKeyOf(dayKey));
    setPickedDay(dayKey);
  };

  return {
    days,
    availableDayKeys,
    todayKey,
    minMonth,
    maxMonth,
    month,
    setNavMonth,
    selectedDay,
    setPickedDay,
    dayColumn,
    nextDay,
    goToDay,
  };
}
