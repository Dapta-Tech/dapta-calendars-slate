'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import {
  buildMonthGrid,
  monogram,
  shiftMonth,
  t,
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
          // Intrinsic size given so the row does not reflow when the image
          // lands. Not `next/image`: the URL is host-supplied (or a data URL)
          // and the optimizer would need a remote allowlist per account.
          <img
            src={avatarUrl}
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 shrink-0 rounded-full object-cover"
          />
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
            <span>{t(m.booking.durationMinutes, { minutes: lengthMinutes })}</span>
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
            <dt className="sr-only">{m.bookingPage.method}</dt>
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
  const grid: CalendarMonth = useMemo(
    () => buildMonthGrid(monthKey, { availableDayKeys, todayKey, locale, weekStartsOn }),
    [monthKey, availableDayKeys, todayKey, locale, weekStartsOn],
  );
  const canGoBack = monthKey > minMonthKey;
  const canGoForward = monthKey < maxMonthKey;

  const days = useMemo(() => grid.weeks.flat(), [grid]);
  const bookable = useMemo(
    () => days.filter((d) => d.inMonth && d.hasSlots).map((d) => d.dayKey),
    [days],
  );

  /**
   * The grid's single tab stop (APG). `role="grid"` is a contract: one Tab
   * lands in the calendar, arrows move within it. Without this every bookable
   * day is its own tab stop — with a 60-day window that is up to forty Tab
   * presses between the timezone picker and the times beside it.
   *
   * Only bookable days can hold the cursor, because only they can be
   * activated; the rest are `disabled` and out of the tab order anyway.
   */
  const cursor =
    selectedDayKey && bookable.includes(selectedDayKey) ? selectedDayKey : (bookable[0] ?? null);
  const gridRef = useRef<HTMLDivElement>(null);

  /** Move the cursor `delta` bookable days and take focus with it. */
  const step = (delta: number) => {
    if (!cursor) return;
    const i = bookable.indexOf(cursor);
    const next = bookable[Math.min(Math.max(i + delta, 0), bookable.length - 1)];
    if (!next || next === cursor) return;
    onSelectDay(next);
    // The cell is re-rendered with the new cursor before focus moves.
    requestAnimationFrame(() =>
      gridRef.current?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus(),
    );
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    // Arrows walk BOOKABLE days rather than calendar days: stepping onto a
    // day with nothing on it would move focus to a disabled control and strand
    // the keyboard there. A week is seven calendar days, so up/down step by the
    // nearest thing the visitor means — a row — through what is pickable.
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        step(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        step(7);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-7);
        break;
      case 'Home':
        e.preventDefault();
        step(-bookable.length);
        break;
      case 'End':
        e.preventDefault();
        step(bookable.length);
        break;
      case 'PageDown':
        if (canGoForward) {
          e.preventDefault();
          onMonthChange(shiftMonth(monthKey, 1));
        }
        break;
      case 'PageUp':
        if (canGoBack) {
          e.preventDefault();
          onMonthChange(shiftMonth(monthKey, -1));
        }
        break;
      default:
        break;
    }
  };

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

      {/* A real ARIA grid. Each row is its own seven-column track rather than
          `display: contents` on a shared one: `contents` has a long history of
          dropping elements out of the accessibility tree, and the row structure
          is the entire reason for claiming grid semantics here. `gridcell` sits
          on the CELL and a real button lives inside it — putting the role on
          the button would replace its implicit one and announce a control as a
          table cell. */}
      <div
        ref={gridRef}
        className="bp-cal-grid"
        role="grid"
        aria-label={grid.label}
        onKeyDown={onGridKeyDown}
      >
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
              const canPick = state === 'available';
              const isSelected = canPick && day.dayKey === selectedDayKey;
              return (
                <div
                  key={day.dayKey}
                  role="gridcell"
                  aria-selected={canPick ? isSelected : undefined}
                  className="contents"
                >
                  <button
                    type="button"
                    data-day={day.dayKey}
                    className="bp-cal-day"
                    data-state={state}
                    data-today={day.isToday ? 'true' : undefined}
                    // The style hook, separate from the ARIA one: `aria-selected`
                    // belongs on the gridcell, and painting the button off its
                    // parent's attribute would silently stop working for any
                    // caller that renders a cell without the wrapper.
                    data-selected={isSelected ? 'true' : undefined}
                    // A day with nothing on it is a date, not a control:
                    // `disabled` keeps it out of the tab order so a keyboard
                    // user moves through the days they can actually book.
                    disabled={!canPick}
                    // Roving tabindex: exactly one cell is tabbable, and the
                    // arrow handler above moves both it and focus.
                    tabIndex={canPick && day.dayKey === cursor ? 0 : -1}
                    // The visible label is "14", which is not a date.
                    aria-label={
                      day.isToday ? `${day.label}, ${m.bookingPage.today}` : day.label
                    }
                    onClick={() => onSelectDay(day.dayKey)}
                  >
                    {day.dayOfMonth}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
