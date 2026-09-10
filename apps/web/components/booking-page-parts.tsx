'use client';

import { type ReactNode } from 'react';
import {
  buildMonthGrid,
  formatDayKeyLong,
  monogram,
  shiftMonth,
  type BookingMessages,
  type CalendarMonth,
} from '@slate/shared';

/**
 * The three-region event page's presentational pieces (BP), split out of
 * `booking-flow.tsx` so that file keeps holding the thing that is actually hard
 * — the hold/book/error state machine — rather than a month grid's markup.
 *
 * Every piece is a pure render over props. None of them fetch, none of them own
 * booking state, and all of them draw from the same `bp-*` class contract as
 * the slot chips, so the nine `bookingPageStyle` axes reach them with no extra
 * wiring (preview == prod).
 */

// --- Icons ----------------------------------------------------------------
// Inline, `currentColor`, 1em — so they inherit the branded text colour and
// the density axis's font size instead of needing their own tokens.

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4 shrink-0'}
    >
      {children}
    </svg>
  );
}

function ClockIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

function GlobeIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </Icon>
  );
}

/**
 * The Where, as a picture. Keyed on the location KIND, which is a
 * vendor-neutral value — a generic camera for conferencing, never a platform's
 * mark (R15 / ADR 0008). An unknown kind falls back to the pin rather than
 * rendering nothing, so a location the host did configure always shows.
 */
function LocationIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'conferencing':
      return (
        <Icon>
          <rect x="2" y="6" width="13" height="12" rx="2" />
          <path d="m15 11 6-3v8l-6-3z" />
        </Icon>
      );
    case 'phone':
      return (
        <Icon>
          <path d="M6 3h4l2 5-2.5 1.5a12 12 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z" />
        </Icon>
      );
    case 'in_person':
    default:
      return (
        <Icon>
          <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
          <circle cx="12" cy="10" r="2.5" />
        </Icon>
      );
  }
}

export function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <Icon className="h-4 w-4">
      <path d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </Icon>
  );
}

// --- Left region: the event panel -----------------------------------------

/**
 * Who, what, how long, where, and in whose clock. Everything an invitee needs
 * to decide BEFORE they look at a time — which is why it sits first in the DOM
 * and first in the mobile stack.
 */
export function EventPanel({
  m,
  hostName,
  avatarUrl,
  eventTitle,
  description,
  lengthMinutes,
  location,
  locationLabel,
  methodLabel,
  timeZoneControl,
}: {
  m: BookingMessages;
  hostName: string;
  avatarUrl?: string | null;
  eventTitle: string;
  description?: string | null;
  lengthMinutes: number;
  location?: { kind: string } | null;
  /** Already rendered by `formatLocation` — never a join URL (C2 owns that). */
  locationLabel?: string | null;
  /** Team scheduling method; personal events pass nothing. */
  methodLabel?: string | null;
  timeZoneControl: ReactNode;
}) {
  return (
    <section aria-label={m.bookingPage.detailsRegion} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
        ) : (
          // B1's initial tile: the same monogram the profile page and the studio
          // preview draw, so a host with no photo is not a hole on one surface
          // and a letter on another.
          <div
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center text-base font-semibold"
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              borderRadius: 'var(--bp-radius)',
            }}
          >
            {monogram(hostName)}
          </div>
        )}
        <p className="min-w-0 break-words text-sm font-medium text-muted-foreground">{hostName}</p>
      </div>

      <div className="flex flex-col gap-2">
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{ fontFamily: 'var(--bp-font-display)' }}
        >
          {eventTitle}
        </h1>
        {description ? (
          <p className="whitespace-pre-line text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        {/* Duration. One length exists in the model today, so this is a static
            chip rather than a disabled picker — a disabled control tells the
            invitee something was taken away, and nothing was. When multiple
            durations land it becomes the trigger and nothing around it moves. */}
        <div className="flex items-center gap-2">
          <dt className="sr-only">{m.bookingPage.duration}</dt>
          <dd className="flex items-center gap-2">
            <ClockIcon />
            <span>{m.booking.durationMinutes.replace('{minutes}', String(lengthMinutes))}</span>
          </dd>
        </div>

        {locationLabel ? (
          <div className="flex items-start gap-2">
            <dt className="sr-only">{m.location.whereLabel}</dt>
            <dd className="flex items-start gap-2">
              <span className="mt-0.5">
                <LocationIcon kind={location?.kind ?? 'in_person'} />
              </span>
              <span className="min-w-0 break-words">{locationLabel}</span>
            </dd>
          </div>
        ) : null}

        {methodLabel ? (
          <div className="flex items-center gap-2">
            <dt className="sr-only">{m.bookingPage.detailsRegion}</dt>
            <dd className="text-muted-foreground">{methodLabel}</dd>
          </div>
        ) : null}

      </dl>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GlobeIcon />
          {m.booking.timezone}
        </span>
        {timeZoneControl}
      </div>
    </section>
  );
}

// --- Centre region: the month calendar ------------------------------------

/**
 * One month at a time. Availability comes from the day keys the slot list
 * already produced, so the grid and the column beside it are two readings of
 * one list and cannot disagree about which days have times.
 *
 * Navigation is bounded by the availability the page was given: there is no
 * previous month before the one holding today, and no next month past the last
 * day with a slot on it. A visitor is never sent to a month the page has no
 * answer for.
 */
export function MonthCalendar({
  m,
  monthKey,
  availableDayKeys,
  todayKey,
  selectedDayKey,
  locale,
  weekStartsOn,
  minMonthKey,
  maxMonthKey,
  onMonthChange,
  onSelectDay,
}: {
  m: BookingMessages;
  monthKey: string;
  availableDayKeys: Set<string>;
  todayKey: string;
  selectedDayKey: string | null;
  locale: string;
  weekStartsOn: number;
  minMonthKey: string;
  maxMonthKey: string;
  onMonthChange: (monthKey: string) => void;
  onSelectDay: (dayKey: string) => void;
}) {
  const grid: CalendarMonth = buildMonthGrid(monthKey, {
    availableDayKeys,
    todayKey,
    locale,
    weekStartsOn,
  });
  const canGoBack = monthKey > minMonthKey;
  const canGoForward = monthKey < maxMonthKey;

  return (
    <section aria-label={m.bookingPage.calendarRegion} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--bp-font-display)' }}>
          {grid.label}
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="bp-icon-btn"
            disabled={!canGoBack}
            aria-label={m.bookingPage.previousMonth}
            onClick={() => onMonthChange(shiftMonth(monthKey, -1))}
          >
            <ChevronIcon direction="left" />
          </button>
          <button
            type="button"
            className="bp-icon-btn"
            disabled={!canGoForward}
            aria-label={m.bookingPage.nextMonth}
            onClick={() => onMonthChange(shiftMonth(monthKey, 1))}
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </div>

      {/* A real ARIA grid: rows carry `display: contents` so the seven-column
          track still comes from the grid container, and a screen reader gets
          the row/column structure a date picker is supposed to have. */}
      <div className="bp-cal-grid" role="grid" aria-label={grid.label}>
        <div role="row" className="bp-cal-week">
          {grid.weekdayLabels.map((label, i) => (
            <div key={`${label}-${i}`} role="columnheader" className="bp-cal-weekday">
              {label}
            </div>
          ))}
        </div>
        {grid.weeks.map((week) => (
          <div role="row" className="bp-cal-week" key={week[0]!.dayKey}>
            {week.map((day) => {
              const state = !day.inMonth ? 'outside' : day.hasSlots ? 'available' : 'empty';
              const bookable = state === 'available';
              // The number alone reads as "14"; the accessible name has to be
              // a date, and has to say when that date is today.
              const spoken = formatDayKeyLong(day.dayKey, locale);
              return (
                <button
                  key={day.dayKey}
                  type="button"
                  role="gridcell"
                  className="bp-cal-day"
                  data-state={state}
                  data-today={day.isToday ? 'true' : undefined}
                  // A day with nothing on it is a date, not a control:
                  // `disabled` keeps it out of the tab order so a keyboard user
                  // moves through the days they can actually book.
                  disabled={!bookable}
                  aria-selected={bookable ? day.dayKey === selectedDayKey : undefined}
                  aria-label={day.isToday ? `${spoken}, ${m.bookingPage.today}` : spoken}
                  onClick={() => onSelectDay(day.dayKey)}
                >
                  {day.dayOfMonth}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
