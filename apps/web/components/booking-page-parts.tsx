'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  buildMonthGrid,
  monogram,
  shiftMonth,
  t,
  type BookingMessages,
  type CalendarMonth,
  type DisplaySlot,
} from '@slate/shared';

/**
 * The event page's presentational pieces, split out of `booking-flow.tsx` so
 * that file keeps holding the thing that is actually hard (the step, hold,
 * book and error state machine) rather than a month grid's markup.
 *
 * Every piece is a pure render over props. None of them fetch, none of them own
 * booking state, and all of them are drawn by the `bp-*` class contract in
 * globals.css, never by a colour utility, so the ten style axes reach every one
 * of them with no extra wiring. The studio's preview composes these same pieces,
 * which is what makes preview == production a property of the code
 * (`preview-parity.spec.tsx`).
 */

// --- Icons ----------------------------------------------------------------
// Inline, `currentColor`, 1em, so they inherit the branded text colour and the
// density axis's font size instead of needing their own tokens.

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
 * vendor-neutral value: a generic camera for conferencing, never a platform's
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

function CheckIcon() {
  return (
    <Icon className="h-5 w-5 shrink-0">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  );
}

function PersonIcon() {
  return (
    <Icon>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Icon>
  );
}

export function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <Icon className="h-4 w-4">
      <path d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </Icon>
  );
}

// --- The event panel --------------------------------------------------------

/**
 * A description with a ceiling.
 *
 * The panel shares the viewport with the calendar, so an unbounded `<p>` here is
 * a panel of unbounded height: a host who pastes an agenda pushes the duration,
 * the location and the time zone off the fold. Four lines are enough to read
 * what the meeting is; the rest is one click away.
 *
 * "Show more" appears only when the text actually runs past four lines. It is
 * measured after layout (and again whenever the panel changes width, which is
 * also when webfonts land), and it starts ABSENT, so the server's HTML and the
 * first client render agree and a short description never carries a control
 * that opens nothing. The full text is always in the DOM: the clamp is
 * `-webkit-line-clamp`, which hides overflow visually and leaves it to a screen
 * reader and to the page's own indexing. `white-space: pre-line` keeps the
 * host's own line breaks.
 */
function EventDescription({ m, description }: { m: BookingMessages; description: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, description]);
  return (
    <div className="bp-description">
      <p
        ref={textRef}
        id={descriptionId}
        className="bp-description-text"
        data-expanded={expanded ? 'true' : undefined}
      >
        {description}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={descriptionId}
          onClick={() => setExpanded((v) => !v)}
          className="bp-link"
        >
          {expanded ? m.bookingPage.descriptionLess : m.bookingPage.descriptionMore}
        </button>
      ) : null}
    </div>
  );
}

/** The host's photo, or the monogram tile the profile page and the studio draw. */
export function HostAvatar({ hostName, avatarUrl }: { hostName: string; avatarUrl?: string | null }) {
  return avatarUrl ? (
    // Intrinsic size given so the row does not reflow when the image lands. Not
    // `next/image`: the URL is host-supplied (or a data URL) and the optimizer
    // would need a remote allowlist per account.
    <img
      src={avatarUrl}
      alt=""
      width={44}
      height={44}
      // The photo may come from the connected account, i.e. a provider CDN. Do
      // not hand that CDN the booking page's URL on every render.
      referrerPolicy="no-referrer"
      className="bp-avatar"
    />
  ) : (
    <div aria-hidden className="bp-avatar bp-avatar-monogram">
      {monogram(hostName)}
    </div>
  );
}

/**
 * Who, what, how long, where, and in whose clock. Everything an invitee needs to
 * decide BEFORE they look at a time, which is why it sits first in the DOM.
 *
 * On a phone it is the compact header of the first step and steps out of the
 * way once a day is picked; from the two-pane width up it is the left pane and
 * stays. The time zone is a FACT here; the control that changes it lives with
 * the times, where the visitor is looking when they need it.
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
  timeZoneLabel,
}: {
  m: BookingMessages;
  hostName: string;
  avatarUrl?: string | null;
  eventTitle: string;
  description?: string | null;
  lengthMinutes: number;
  location?: { kind: string } | null;
  /** Already rendered by `formatLocation`; never a join URL (C2 owns that). */
  locationLabel?: string | null;
  /** Team scheduling method; personal events pass nothing. */
  methodLabel?: string | null;
  /** The HOST's zone, as a person reads it: a fact about them, not a setting.
   *  The visitor's own zone is the control beside the times. */
  timeZoneLabel: string;
}) {
  return (
    <section aria-label={m.bookingPage.detailsRegion} className="bp-event">
      <div className="bp-host">
        <HostAvatar hostName={hostName} avatarUrl={avatarUrl} />
        <p className="bp-host-name">{hostName}</p>
      </div>

      <h1 className="bp-event-title">{eventTitle}</h1>

      {/* The facts come BEFORE the prose: they are fixed-height and they are what
          an invitee needs in order to decide. */}
      <dl className="bp-facts">
        {/* One duration exists in the model today, so this is a fact rather than
            a disabled picker: a disabled control tells the invitee something was
            taken away, and nothing was. */}
        <div className="bp-fact">
          <dt className="sr-only">{m.bookingPage.duration}</dt>
          <dd>
            <ClockIcon />
            <span>{t(m.booking.durationMinutes, { minutes: lengthMinutes })}</span>
          </dd>
        </div>

        {locationLabel ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.location.whereLabel}</dt>
            <dd>
              <LocationIcon kind={location?.kind ?? 'in_person'} />
              <span className="bp-fact-text">{locationLabel}</span>
            </dd>
          </div>
        ) : null}

        <div className="bp-fact">
          <dt className="sr-only">{m.booking.timezone}</dt>
          <dd>
            <GlobeIcon />
            <span className="bp-fact-text">{t(m.bookingPage.hostTimeZone, { zone: timeZoneLabel })}</span>
          </dd>
        </div>

        {methodLabel ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.bookingPage.method}</dt>
            <dd className="bp-muted">{methodLabel}</dd>
          </div>
        ) : null}
      </dl>

      {description ? <EventDescription m={m} description={description} /> : null}
    </section>
  );
}

// --- The sequence's chrome ----------------------------------------------------

/** The sequence's steps, in order. `details` and `done` are derived in the island. */
export type BookingStep = 'calendar' | 'times' | 'details' | 'done';
export const STEP_NUMBER: Record<BookingStep, number> = { calendar: 1, times: 2, details: 3, done: 4 };

/**
 * The stage every state of the event page renders into: the container the
 * layout queries (`.bp-flow`), the step stamped for globals.css to lay out
 * (`data-step`), the direction of the last move for the phone's slide
 * (`data-dir`), and the progress track. The island and the studio's preview
 * both render through this, so their outer markup cannot drift.
 */
export function BookingStage({
  m,
  step,
  dir,
  stageRef,
  children,
}: {
  m: BookingMessages;
  step: BookingStep;
  dir?: 'forward' | 'back' | null;
  stageRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className="bp-flow">
      <div ref={stageRef} className="bp-stage" data-step={step} data-dir={dir ?? undefined}>
        <ProgressTrack m={m} step={STEP_NUMBER[step]} of={4} />
        {children}
      </div>
    </div>
  );
}

/**
 * The frame while a time is being chosen: the event pane, and the right pane
 * holding the month and the day's times (or, with no times at all, the sentence
 * that says why). Shared by the island and the studio's preview.
 */
export function ChoosingFrame({
  panel,
  month,
  times,
  empty,
}: {
  panel: ReactNode;
  month?: ReactNode;
  times?: ReactNode;
  /** Rendered instead of the month and the times when there are none. */
  empty?: ReactNode;
}) {
  return (
    <div className="bp-frame bp-card">
      <div className="bp-pane-event bp-region">{panel}</div>
      <div className="bp-pane-main">
        {empty ?? (
          <div className="bp-pick">
            <div className="bp-pane-month bp-region">{month}</div>
            <div className="bp-pane-times bp-region">{times}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the visitor is in the sequence, as a 4px track (phones only; the
 * two-pane layout shows every step's context at once and needs no track).
 * `step` is 1-based out of `of`.
 */
export function ProgressTrack({ m, step, of }: { m: BookingMessages; step: number; of: number }) {
  return (
    <div
      className="bp-progress"
      role="progressbar"
      aria-label={t(m.bookingPage.progress, { step, of })}
      aria-valuemin={1}
      aria-valuemax={of}
      aria-valuenow={step}
    >
      <span style={{ width: `${(step / of) * 100}%` }} />
    </div>
  );
}

/** The back affordance of a step: a chevron and the place it goes back to. */
export function BackButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`bp-back${className ? ` ${className}` : ''}`}>
      <ChevronIcon direction="left" />
      <span>{label}</span>
    </button>
  );
}

// --- The day's times ---------------------------------------------------------

/**
 * 12h / 24h. A two-button radio group, not a switch: neither format is "on". A
 * radio group is one tab stop with arrows moving between the options (APG), so
 * the roving tabindex and the arrow handler are part of the role, not decoration.
 */
export function HourFormatToggle({
  m,
  hour12,
  onChange,
}: {
  m: BookingMessages;
  hour12: boolean;
  onChange: (hour12: boolean) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={m.bookingPage.timeFormat}
      className="bp-segmented"
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const group = e.currentTarget;
        onChange(!hour12);
        // Focus follows the selection, or it would sit on the button that just
        // became `tabIndex={-1}` and the next Tab would leave from nowhere.
        requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
      }}
    >
      {([true, false] as const).map((is12) => (
        <button
          key={String(is12)}
          type="button"
          role="radio"
          aria-checked={hour12 === is12}
          tabIndex={hour12 === is12 ? 0 : -1}
          onClick={() => onChange(is12)}
          className="bp-segment"
        >
          {is12 ? m.bookingPage.hour12 : m.bookingPage.hour24}
        </button>
      ))}
    </div>
  );
}

/** One bookable time. Single line, fixed height, never wraps (R30 §4). */
export function SlotChip({
  m,
  slot,
  onPick,
  selected = false,
}: {
  m: BookingMessages;
  slot: DisplaySlot;
  onPick?: (slot: DisplaySlot) => void;
  selected?: boolean;
}) {
  const isGroup = (slot.capacity ?? 1) > 1;
  const full = isGroup && (slot.spotsLeft ?? 1) <= 0;
  return (
    <button
      type="button"
      onClick={onPick ? () => onPick(slot) : undefined}
      disabled={full}
      aria-pressed={selected}
      className="bp-slot"
    >
      <span className="bp-slot-time">{slot.label}</span>
      {isGroup ? (
        <span className="bp-slot-seats">{full ? m.booking.full : t(m.booking.seatsLeft, { n: slot.spotsLeft ?? 0 })}</span>
      ) : null}
    </button>
  );
}

/**
 * The chosen day's times: the day as a title (sticky on a phone, with the way
 * back to the month beside it), the time zone and the hour format as quiet
 * controls, and the times themselves, flowing in the page. No inner scroller
 * (R30 §2): a long day makes the page longer, and the page scrolls.
 *
 * It is a `.bp-day` group, which is what gives the `dayGroup` axis something to
 * draw: `flat` leaves the times on the page, `boxed` frames them.
 */
export function TimesColumn({
  m,
  dayTitle,
  slots,
  emptyText,
  onPick,
  onBack,
  hour12,
  onHour12Change,
  timeZoneControl,
  titleRef,
  next,
}: {
  m: BookingMessages;
  /** "Monday, March 2", or null before any day is chosen. */
  dayTitle: string | null;
  slots: DisplaySlot[];
  /** Shown instead of the times when there are none. */
  emptyText: string;
  onPick?: (slot: DisplaySlot) => void;
  /** The phone's way back to the month. Hidden from the two-pane width up. */
  onBack?: () => void;
  hour12: boolean;
  onHour12Change: (hour12: boolean) => void;
  timeZoneControl: ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
  /**
   * The next day with times, when there is one. The list ends with a quiet way
   * to it, so a day with two times is a short list that says where to look
   * next, never a column of empty space or filler.
   */
  next?: { heading: string; onGo: () => void } | null;
}) {
  return (
    <section aria-label={m.bookingPage.timesRegion} className="bp-day bp-times">
      <div className="bp-day-head">
        {onBack ? <BackButton label={m.bookingPage.backToCalendar} onClick={onBack} className="bp-back-phone" /> : null}
        <h2 ref={titleRef} tabIndex={-1} className="bp-day-title">
          {dayTitle ?? m.bookingPage.timesRegion}
        </h2>
        <HourFormatToggle m={m} hour12={hour12} onChange={onHour12Change} />
      </div>
      <div className="bp-times-tools">{timeZoneControl}</div>
      {slots.length ? (
        <div className="bp-slots">
          {slots.map((s) => (
            <SlotChip key={s.startUtc} m={m} slot={s} onPick={onPick} />
          ))}
        </div>
      ) : (
        <p className="bp-muted">{emptyText}</p>
      )}
      {next ? (
        <button type="button" onClick={next.onGo} className="bp-next-day">
          <span>{t(m.bookingPage.nextTimes, { day: next.heading })}</span>
          <ChevronIcon direction="right" />
        </button>
      ) : null}
    </section>
  );
}

// --- The details step ---------------------------------------------------------

/**
 * The time the visitor chose, restated at the top of the form, so the last
 * screen before "Confirm" says what is being confirmed. The hold is quiet text
 * under the time, not a banner: it is a fact, not a warning.
 */
export function ChosenTime({
  m,
  eventTitle,
  dayLine,
  timeLine,
  timeZoneLabel,
  holdLine,
  holdError,
  onBack,
  titleRef,
  timeZoneControl,
}: {
  m: BookingMessages;
  eventTitle: string;
  /** "Monday, March 2, 2026" */
  dayLine: string;
  /** "9:30 to 10:15 AM" */
  timeLine: string;
  timeZoneLabel: string;
  /** The zone control, so the time can still be read in another zone here. */
  timeZoneControl?: ReactNode;
  holdLine?: string | null;
  holdError?: string | null;
  onBack: () => void;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="bp-chosen">
      <BackButton label={m.bookingPage.backToTimes} onClick={onBack} />
      <h2 ref={titleRef} tabIndex={-1} className="bp-chosen-title">
        {eventTitle}
      </h2>
      <p className="bp-chosen-when">
        <span>{dayLine}</span>
        <span>{timeLine}</span>
      </p>
      {timeZoneControl ?? <p className="bp-muted bp-small">{timeZoneLabel}</p>}
      {holdLine ? <p className="bp-muted bp-small">{holdLine}</p> : null}
      {holdError ? <p className="bp-error">{holdError}</p> : null}
    </div>
  );
}

// --- A booking that exists -------------------------------------------------------

/**
 * A booking as it stands, for the manage page's event pane: what, when in the
 * attendee's clock, with whom, where, the way in when it is online, and its
 * state when it is not simply confirmed. The facts are the confirmation's, in
 * the same order, so the page an email links to reads like the screen the
 * booking ended on.
 */
export function BookingSummary({
  m,
  eyebrow,
  title,
  dayLine,
  timeLine,
  timeZoneLabel,
  unreadableTime,
  withLine,
  locationLabel,
  locationKind,
  joinUrl,
  statusLine,
}: {
  m: BookingMessages;
  /** The quiet line above the title ("Manage your booking"). */
  eyebrow: string;
  title: string;
  dayLine: string | null;
  timeLine: string | null;
  timeZoneLabel: string;
  /** Said in place of the time when the booking's instant could not be read. */
  unreadableTime: string;
  /** "With Riley Chen · sam@example.com" */
  withLine: string;
  locationLabel?: string | null;
  locationKind?: string | null;
  /** An http(s) join link, or nothing. */
  joinUrl?: string | null;
  /** "This booking is cancelled.", when it is not simply confirmed. */
  statusLine?: string | null;
}) {
  return (
    <section className="bp-event" aria-label={eyebrow}>
      <p className="bp-muted bp-small">{eyebrow}</p>
      <h1 className="bp-event-title">{title}</h1>
      <dl className="bp-facts">
        <div className="bp-fact">
          <dt className="sr-only">{m.bookingPage.when}</dt>
          <dd>
            <ClockIcon />
            <span className="bp-fact-text">
              {dayLine && timeLine ? (
                <>
                  {dayLine}
                  <br />
                  {timeLine} <span className="bp-muted">({timeZoneLabel})</span>
                </>
              ) : (
                unreadableTime
              )}
            </span>
          </dd>
        </div>
        <div className="bp-fact">
          <dt className="sr-only">{m.bookingPage.who}</dt>
          <dd>
            <PersonIcon />
            <span className="bp-fact-text">{withLine}</span>
          </dd>
        </div>
        {locationLabel ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.location.whereLabel}</dt>
            <dd>
              <LocationIcon kind={locationKind ?? 'in_person'} />
              <span className="bp-fact-text">{locationLabel}</span>
            </dd>
          </div>
        ) : null}
      </dl>
      {joinUrl ? (
        <a href={joinUrl} target="_blank" rel="noopener noreferrer" className="bp-btn-outline bp-cta">
          {m.manage.joinMeeting}
          <span className="sr-only">{m.manage.joinMeetingOpensNewTab}</span>
        </a>
      ) : null}
      {statusLine ? <p className="bp-error">{statusLine}</p> : null}
    </section>
  );
}

// --- The confirmation -----------------------------------------------------------

/**
 * The booking, said back: what, when in the visitor's own clock, with whom and
 * where, then the two things a person does next. A single column; the
 * attribution badge sits under the page, not in here.
 */
export function BookingConfirmation({
  m,
  pending,
  eventTitle,
  dayLine,
  timeLine,
  timeZoneLabel,
  hostName,
  locationLabel,
  locationKind,
  sentTo,
  actions,
  footer,
  titleRef,
}: {
  m: BookingMessages;
  pending: boolean;
  eventTitle: string;
  dayLine: string | null;
  timeLine: string | null;
  timeZoneLabel: string;
  hostName?: string | null;
  locationLabel?: string | null;
  locationKind?: string | null;
  /** "A confirmation was sent to …", already localised; null drops the line. */
  sentTo: string | null;
  actions: ReactNode;
  footer?: ReactNode;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="bp-card bp-confirmation" aria-labelledby="bp-confirmation-title">
      <div aria-hidden className="bp-confirmation-mark" data-pending={pending ? 'true' : undefined}>
        {pending ? <ClockIcon /> : <CheckIcon />}
      </div>
      <h2 id="bp-confirmation-title" ref={titleRef} tabIndex={-1} className="bp-confirmation-title">
        {pending ? m.booking.requested : m.booking.confirmed}
      </h2>
      {sentTo ? <p className="bp-muted">{sentTo}</p> : null}

      <dl className="bp-facts bp-confirmation-facts">
        <div className="bp-fact">
          <dt className="sr-only">{m.bookingPage.what}</dt>
          <dd className="bp-strong">{eventTitle}</dd>
        </div>
        {dayLine && timeLine ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.bookingPage.when}</dt>
            <dd>
              <ClockIcon />
              <span className="bp-fact-text">
                {dayLine}
                <br />
                {timeLine} <span className="bp-muted">({timeZoneLabel})</span>
              </span>
            </dd>
          </div>
        ) : null}
        {hostName ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.bookingPage.who}</dt>
            <dd>
              <PersonIcon />
              <span className="bp-fact-text">{hostName}</span>
            </dd>
          </div>
        ) : null}
        {locationLabel ? (
          <div className="bp-fact">
            <dt className="sr-only">{m.location.whereLabel}</dt>
            <dd>
              <LocationIcon kind={locationKind ?? 'in_person'} />
              <span className="bp-fact-text">{locationLabel}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="bp-confirmation-actions">{actions}</div>
      {footer}
    </section>
  );
}

// --- The month calendar ------------------------------------------------------

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
  onCursorDay,
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
  /** A day was ACTIVATED (click, Enter, Space): the visitor chose it. */
  onSelectDay: (dayKey: string) => void;
  /**
   * The keyboard cursor moved onto a day (arrows, Home, End). Moving is not
   * choosing: on a phone choosing a day moves to its times, and an arrow key
   * must not do that. Defaults to `onSelectDay` for a caller that does not
   * tell the two apart.
   */
  onCursorDay?: (dayKey: string) => void;
}) {
  const grid: CalendarMonth = useMemo(
    // Six weeks, always: the frame sizes to its content, so every month has to
    // be the same height or the page would move between months.
    () => buildMonthGrid(monthKey, { availableDayKeys, todayKey, locale, weekStartsOn, minWeeks: 6 }),
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
    (onCursorDay ?? onSelectDay)(next);
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
    <section aria-label={m.bookingPage.calendarRegion} className="bp-month">
      <div className="bp-month-head">
        <h2 className="bp-month-label">{grid.label}</h2>
        <div className="bp-month-nav">
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
