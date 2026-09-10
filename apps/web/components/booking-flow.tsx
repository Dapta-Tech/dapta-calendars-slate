'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatLocation,
  formatSlotDateTime,
  getMessages,
  groupSlotsByDay,
  isReservedFieldName,
  monthKeyOf,
  t,
  validateBookingFieldValue,
  weekStartsOnFor,
  zonedTodayKey,
  type DisplaySlot,
  type Slot,
} from '@slate/shared';
import { EventPanel, MonthCalendar } from '@/components/booking-page-parts';

/** Mirror of the server's attendee-email rule — catches the 400 before a
 *  round-trip, so a typo never costs the visitor their filled-in form. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import type { BookingField } from '@slate/types';
import { bookAction, releaseAction, reserveAction } from '@/app/[accountCode]/[handle]/[slug]/actions';
import { type BookResult } from '@/lib/api';
import { signupHref } from '@/lib/growth';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { PhoneField, isPhoneValueTooShort } from '@/components/ui/phone-field';
import { postBookingScheduled } from '@/lib/embed-messages';

interface Props {
  accountCode: string;
  /** Member handle (personal) or team slug (team). */
  ownerSlug: string;
  slug: string;
  slots: Slot[];
  /**
   * Why `slots` is empty, when it's a config error (API reason code). Public
   * pages map every code to GENERIC copy — internals are never named here;
   * the actionable detail lives on the admin surfaces.
   */
  emptyReason?: string;
  bookingFields: BookingField[];
  initialTimeZone: string;
  mode?: 'personal' | 'team';
  /** Visitor locale ('en' | 'es') for EN/ES copy. */
  locale?: string;

  // --- The event panel (BP) ---------------------------------------------
  // These moved out of the two route headers when the page became three
  // regions. They are props rather than a second fetch because the routes
  // already hold every one of them from the reads they do today.
  eventTitle: string;
  lengthMinutes: number;
  description?: string | null;
  /** Host display name, or the team name on a team event. */
  hostName: string;
  avatarUrl?: string | null;
  /** Raw location — the label comes from `formatLocation`, the icon from the kind. */
  location?: { kind: string; detail?: string | null } | null;
  /** Team scheduling method label; personal events pass nothing. */
  methodLabel?: string | null;
  /**
   * The instant the server rendered at. "Today", and therefore the first month
   * and which days are past, are derived from THIS rather than from `new
   * Date()`, so the server's HTML and the client's hydration cannot disagree
   * about the date when a render straddles midnight.
   */
  nowUtc: string;
  /**
   * Inline embed mode (E). Changes two things and nothing else: a completed
   * booking is announced to the host page, and the confirmation's Manage link
   * opens a new tab instead of navigating the frame.
   */
  embed?: boolean;
}

interface Hold {
  uid: string;
  expiresAt: string;
}

/**
 * The interactive island: pick a timezone, pick a day, pick a slot (which
 * places a soft HOLD), fill the form, book. Slots are absolute UTC instants (a
 * tz switch regroups the calendar AND the column with no refetch). Errors
 * surface by HTTP status: 409 slot-taken and 410 hold-expired both offer a
 * Retry (R22 error+retry). Branding renders via the ancestor `.branded-surface`
 * classes + `--bp-*` vars (preview == prod).
 *
 * The layout is the three regions every invitee already knows (BP): the event
 * panel, a month calendar, and the chosen day's times. Once a time is picked
 * the calendar folds away and the form takes its room — the form is the same
 * form, re-parented, not rewritten, and so are the confirmation and every
 * failure card below it.
 */
export function BookingFlow({
  accountCode,
  ownerSlug,
  slug,
  slots,
  emptyReason,
  bookingFields,
  initialTimeZone,
  mode = 'personal',
  locale = 'en',
  eventTitle,
  lengthMinutes,
  description,
  hostName,
  avatarUrl,
  location,
  methodLabel,
  nowUtc,
  embed = false,
}: Props) {
  const messages = getMessages(locale);
  const m = messages.booking;
  const bp = messages.bookingPage;
  const pm = messages.phonePicker;
  // Reserved names (name/email/notes) are fixed attendee fields this form
  // always asks by itself — a legacy custom question reusing one would ask
  // the attendee twice (QA3 fix 3).
  const visibleFields = useMemo(
    () => bookingFields.filter((f) => !isReservedFieldName(f.name)),
    [bookingFields],
  );
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  /**
   * 12h/24h, defaulted from the LOCALE rather than from the browser. Reading
   * `Intl.DateTimeFormat().resolvedOptions().hourCycle` on the client would
   * disagree with what the server rendered and hydrate-mismatch every slot
   * label on the page. The toggle overrides it for the session; nothing is
   * persisted, because this page stores nothing.
   */
  const [hour12, setHour12] = useState(() => !locale.toLowerCase().startsWith('es'));
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
  const [selected, setSelected] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  /**
   * The error result the booker has already acknowledged, held BY IDENTITY
   * rather than as a boolean.
   *
   * `useActionState` keeps the previous state until the next action resolves,
   * so a boolean cannot tell "this error is still current" from "this error is
   * last attempt's, still on screen while the new one is in flight". Comparing
   * objects can: `bookAction` returns a fresh object per attempt, so a stale
   * result stays dismissed and a genuinely new one always renders — during the
   * request, and after picking a different slot.
   */
  const [dismissedResult, setDismissedResult] = useState<BookResult | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  // CONTROLLED values for every visible input: React 19 resets uncontrolled
  // form fields when the action returns, so a server-side 400 used to wipe
  // everything the visitor had typed (QA2 fix 3).
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, formAction, pending] = useActionState<BookResult | null, FormData>(bookAction, null);

  /**
   * The one host-facing message (E, #67): `dapta-calendars.booking_scheduled`,
   * posted to the framing page when a booking lands.
   *
   * Keyed on the booking's uid rather than fired from the confirmation branch,
   * because that branch re-renders on every state change below it — a host
   * counting conversions must not count one booking several times. The payload
   * is PII-free by construction (see `postBookingScheduled`): `targetOrigin` is
   * `'*'`, so any page framing this one receives it.
   */
  const announcedUid = useRef<string | null>(null);
  const booked = result?.ok && result.booking ? result.booking : null;
  const bookedUid = booked?.uid ?? null;
  const bookedStart = booked?.startUtc ?? null;
  useEffect(() => {
    if (!embed || !bookedUid || !bookedStart) return;
    // The uid is the booking's IDENTITY. `useActionState` hands back a fresh
    // object on every attempt and this branch re-renders on every state change
    // below it, so guarding on the value rather than on the object is what
    // keeps a host's conversion counter from counting one booking twice.
    if (announcedUid.current === bookedUid) return;
    announcedUid.current = bookedUid;
    postBookingScheduled({ uid: bookedUid, startUtc: bookedStart, eventTypeSlug: slug });
  }, [embed, bookedUid, bookedStart, slug]);

  /** Full client-side gate, replacing native validation (noValidate): native
   *  bubbles doubled up with the inline errors and can't be themed. Returns
   *  true when the form may submit. */
  function validateAll(): boolean {
    let ok = true;
    if (!name.trim()) {
      setNameError(m.requiredField);
      ok = false;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError(email.trim() ? m.invalidEmail : m.requiredField);
      ok = false;
    }
    const nextFieldErrors: Record<string, string | null> = {};
    for (const f of visibleFields) {
      const v = (answers[f.name] ?? '').trim();
      // Phone values are E.164 from PhoneField — gate on the SAME too-short
      // rule the field flags inline, so a submit never blocks invisibly.
      const err =
        f.required && !v
          ? m.requiredField
          : f.type === 'phone'
            ? isPhoneValueTooShort(v)
              ? pm.invalid
              : null
            : v
              ? validateBookingFieldValue(f.type, v)
              : null;
      nextFieldErrors[f.name] = err;
      if (err) ok = false;
    }
    setFieldErrors((e) => ({ ...e, ...nextFieldErrors }));
    return ok;
  }

  const days = useMemo(
    () => groupSlotsByDay(slots, timeZone, { locale, hour12 }),
    [slots, timeZone, locale, hour12],
  );

  /**
   * Everything the calendar needs, derived from the SAME day buckets the
   * column renders. Two readings of one list — so the grid can never offer a
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
      maxMonth: monthKeyOf(last < today ? today : last),
      // Open on the month the times actually start in. A host fully booked
      // this month, or whose availability begins next month, would otherwise
      // open on a grid of greyed-out days with nothing saying that "next" is
      // the answer.
      firstMonth: monthKeyOf(first) < min ? min : monthKeyOf(first),
    };
  }, [days, timeZone, nowUtc]);

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
  const locationLabel = formatLocation(location ?? null, messages);
  const weekStartsOn = weekStartsOnFor(locale);

  async function pick(slot: DisplaySlot) {
    setSelected(slot.startUtc);
    // The last attempt's error stays dismissed: picking a slot used to clear
    // the flag while `result` still held that error, so choosing a new time
    // after a conflict re-rendered the conflict card straight back.
    setDismissedResult(result);
    setHoldError(null);
    // Moving to another time orphans the hold on this one — give it back (#135).
    // AWAITED, unlike the one in `retry()`: `reserveSlot` re-checks the engine
    // before holding, so a release still in flight would make re-picking the
    // slot you just left answer INVALID_SLOT.
    if (hold) await releaseAction(hold.uid);
    setHold(null);
    // Team events resolve their host set at booking time (round-robin picks one,
    // collective/fixed assign the required hosts) — no per-host hold here.
    if (mode !== 'personal') return;
    // Group events (capacity > 1) fill seats on ONE booking; a per-person hold
    // would blank the whole slot, so skip the hold for group slots.
    if ((slot.capacity ?? 1) > 1) return;
    const r = await reserveAction({ accountCode, handle: ownerSlug, slug, startUtc: slot.startUtc });
    if (r.ok && r.reservationUid) setHold({ uid: r.reservationUid, expiresAt: r.expiresAt! });
    else setHoldError(r.message ?? 'Could not hold this time.');
  }

  /**
   * Forget the slot and go back to the times. Reached two ways: the retry on a
   * 409/410, and the explicit "back to times" on the form.
   *
   * It RELEASES the hold (#135) rather than only forgetting it: "back to times"
   * is how a booker compares Tuesday against Thursday, so a hold left standing
   * for its full ten-minute TTL would hide that slot from every other visitor
   * for no reason. Fire-and-forget — the release answers the same success
   * whether or not the hold was still there, and the booker is already gone.
   */
  function retry() {
    setSelected(null);
    if (hold) void releaseAction(hold.uid);
    setHold(null);
    setHoldError(null);
    setDismissedResult(result);
  }

  /**
   * Duplicate-booking guard (#69): the booker is blocked on their ADDRESS, not
   * on the time, so `retry()` — which drops the slot and sends them back to the
   * grid — is exactly the wrong move. Dismiss the error and keep the slot, the
   * hold and everything they typed, so correcting a typo'd email is one edit.
   */
  function dismissDuplicate() {
    setDismissedResult(result);
  }

  // --- Confirmed ----------------------------------------------------------
  if (result?.ok && result.booking) {
    const b = result.booking;
    const isPending = b.status === 'pending';
    const g = getMessages(locale).growth;
    const ctaHref = signupHref('confirmation', accountCode);
    /**
     * This branch is shared by the personal and the team path, and it must
     * never be able to THROW: `formatSlotDateTime` raises `RangeError: Invalid
     * time value` on an unparseable instant, that escapes to the public error
     * boundary, and the booker is shown a failure screen for a booking that
     * succeeded — which is how they end up making a second one (#102). The
     * team route now returns the same full `BookingView` the personal one
     * does; this is the belt to that braces, so a future shape drift costs the
     * confirmation a line of detail rather than the confirmation itself.
     */
    const when = Number.isNaN(Date.parse(b.startUtc ?? ''))
      ? null
      : formatSlotDateTime(b.startUtc, timeZone, locale, hour12);
    // Dropped rather than interpolated empty: both strings end in the address,
    // so a missing one renders "A confirmation was sent to ." — worse than
    // saying nothing.
    const attendeeEmail = b.attendee?.email;
    return (
      // A confirmation is one column of prose; the wide three-region canvas
      // above it would stretch a two-line sentence across the whole screen.
      <div className="mx-auto max-w-2xl">
        <section className="bp-card border border-border bg-card p-6 text-card-foreground">
          <h2 className="mb-2 text-xl font-semibold">{isPending ? m.requested : m.confirmed}</h2>
          <p className="text-muted-foreground">{when ? `${b.title} — ${when}` : b.title}</p>
          {attendeeEmail ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {isPending
                ? t(m.awaitingConfirmation, { email: attendeeEmail })
                : t(m.confirmationSentTo, { email: attendeeEmail })}
            </p>
          ) : null}
          {b.manageUrl ? (
            // Inside a frame this must open a new tab. Left to navigate the
            // frame it drops the invitee into the manage page inside a short
            // box with nothing to get back with — and `/manage/[uid]` is
            // `frame-ancestors 'self'`, so it would refuse to render there at
            // all on the very click that was supposed to help them.
            <a
              href={b.manageUrl}
              {...(embed ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="mt-4 inline-block text-sm text-primary underline underline-offset-4"
            >
              {getMessages(locale).manage.title} →
            </a>
          ) : null}
        </section>
        {/* Growth loop (R11): a quiet secondary line — a link, never a second
            primary CTA (R30) — gated by the same open-core badge switch. */}
        {ctaHref ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {g.ctaQuestion}{' '}
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
            >
              {g.ctaAction}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  // The duplicate-booking guard (#69) answers 409, like a taken slot — but it
  // is a different failure and gets its own card BEFORE the conflict branch.
  // Left to fall through, it would render "that time was just taken" over a
  // "pick another slot" button, telling the booker to do the one thing that
  // cannot possibly help: the block is on their email, not on the time.
  // `result !== dismissedResult` is the freshness test: an error the booker has
  // acknowledged stays hidden until the NEXT attempt produces a different
  // object, so nothing here can render last attempt's failure over an in-flight
  // request or over a newly picked slot.
  const live = result && !result.ok && result !== dismissedResult;
  const duplicate = live && result.error === 'DUPLICATE_BOOKING';
  const conflict = live && !duplicate && (result.status === 409 || result.status === 410);
  const intakeError = live && result.status === 400;

  // --- Duplicate booking (409 DUPLICATE_BOOKING) --------------------------
  // The copy names NO date, time or host: revealing the existing slot would
  // hand a third party's schedule to anyone who guesses an email, and the
  // person it belongs to already has the confirmation in their inbox.
  if (duplicate) {
    return (
      <section className="bp-card mx-auto max-w-2xl border border-destructive bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">{m.duplicateGuard.title}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{m.duplicateGuard.body}</p>
        <button
          type="button"
          onClick={dismissDuplicate}
          className="bp-btn px-4 py-2 font-semibold transition-transform active:scale-[0.98]"
        >
          {m.duplicateGuard.changeEmail}
        </button>
      </section>
    );
  }

  // --- Conflict (409/410): R22 error + retry ------------------------------
  // CALENDAR_UNAVAILABLE (booking blocked fail-closed) gets its own localized
  // copy — a generic "try again shortly", never internals.
  if (conflict) {
    const calUnavailable = result!.error === 'CALENDAR_UNAVAILABLE';
    return (
      <section className="bp-card mx-auto max-w-2xl border border-destructive bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">
          {calUnavailable ? m.calendarUnavailableTitle : result!.status === 410 ? m.holdExpired : m.slotTaken}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {calUnavailable ? m.calendarUnavailableBody : result!.message}
        </p>
        <button
          type="button"
          onClick={retry}
          className="bp-btn px-4 py-2 font-semibold transition-transform active:scale-[0.98]"
        >
          {m.pickAnother}
        </button>
      </section>
    );
  }

  // Every slot the page holds is empty for one of three reasons, and the copy
  // has always distinguished them. Hoisted so both the calendar-less empty
  // state and the day column can say the right one.
  const emptyCopy =
    emptyReason === 'CALENDAR_UNAVAILABLE'
      ? m.timesUnavailable
      : emptyReason
        ? m.noTimesNow
        : m.noSlots;

  const timeZoneControl = (
    // Themed combobox, not the native <select>: the OS popup for ~400 zones is
    // un-brandable and covers the screen (QA2 fix 1). It renders through P's
    // `Select` — the width comes from this wrapper, per that component's
    // convention, so the panel and the trigger stay the same width.
    <div className="w-full">
      <TimeZoneSelect
        id="tz"
        value={timeZone}
        onChange={setTimeZone}
        locale={locale}
        ariaLabel={m.timezone}
      />
    </div>
  );

  const panel = (
    <EventPanel
      m={messages}
      hostName={hostName}
      avatarUrl={avatarUrl}
      eventTitle={eventTitle}
      description={description}
      lengthMinutes={lengthMinutes}
      location={location}
      locationLabel={locationLabel}
      methodLabel={methodLabel}
      timeZoneControl={timeZoneControl}
    />
  );

  // --- A slot is chosen: panel + form -------------------------------------
  // The calendar folds away rather than shrinking the form into a 17rem
  // gutter. Getting back to the times is one button, running the same `retry`
  // a 409 uses so there is one exit path rather than two that can drift.
  if (selected) {
    return (
      <div className="bp-canvas grid gap-8 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {panel}
          <button
            type="button"
            onClick={retry}
            className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {bp.backToTimes}
          </button>
        </div>
        <aside aria-label={bp.yourDetails} className="md:sticky md:top-6 md:self-start">
          <form
            action={formAction}
            noValidate
            // Client-side gate: block the submit (and the field wipe it used
            // to cause) instead of round-tripping a guaranteed 400.
            onSubmit={(e) => {
              if (!validateAll()) e.preventDefault();
            }}
            className="bp-card flex flex-col gap-3 border border-border bg-card p-4"
          >
            <input type="hidden" name="accountCode" value={accountCode} />
            <input type="hidden" name="ownerSlug" value={ownerSlug} />
            <input type="hidden" name="kind" value={mode} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="startUtc" value={selected} />
            <input type="hidden" name="timeZone" value={timeZone} />
            {hold ? <input type="hidden" name="reservationUid" value={hold.uid} /> : null}

            <p className="text-sm font-medium">
              {formatSlotDateTime(selected, timeZone, locale, hour12)}
            </p>
            {hold ? (
              <p className="text-xs text-muted-foreground">
                {t(m.heldUntil, {
                  time: new Intl.DateTimeFormat(locale, {
                    hour: 'numeric',
                    minute: '2-digit',
                    // The countdown follows the same 12h/24h choice as the slot
                    // the booker just picked; two clocks on one card is a bug.
                    ...(hour12 ? { hour12: true } : { hourCycle: 'h23' as const }),
                  }).format(new Date(hold.expiresAt)),
                })}
              </p>
            ) : holdError ? (
              <p className="text-xs text-destructive">{holdError}</p>
            ) : null}

            <label className="flex flex-col gap-1 text-sm">
              <span>{m.yourName} <span className="text-destructive">*</span></span>
              <input
                name="name"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                aria-invalid={!!nameError}
                className={`rounded-md border bg-background px-3 py-2 ${
                  nameError ? 'border-destructive' : 'border-input'
                }`}
              />
              {nameError ? (
                <span role="alert" className="text-xs text-destructive">
                  {nameError}
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{m.yourEmail} <span className="text-destructive">*</span></span>
              <input
                name="email"
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                onBlur={() =>
                  setEmailError(
                    email.trim() && !EMAIL_RE.test(email.trim()) ? m.invalidEmail : null,
                  )
                }
                aria-invalid={!!emailError}
                className={`rounded-md border bg-background px-3 py-2 ${
                  emailError ? 'border-destructive' : 'border-input'
                }`}
              />
              {emailError ? (
                <span role="alert" className="text-xs text-destructive">
                  {emailError}
                </span>
              ) : null}
            </label>

            {visibleFields.map((f) => {
              const validate = (v: string) =>
                setFieldErrors((e) => ({ ...e, [f.name]: validateBookingFieldValue(f.type, v) }));
              const setAnswer = (v: string) => setAnswers((a) => ({ ...a, [f.name]: v }));
              const value = answers[f.name] ?? '';
              const isMulti = f.type === 'textarea' || f.type === 'guests';
              return (
                <label key={f.name} className="flex flex-col gap-1 text-sm">
                  {/* Required marker stays INLINE with the label (Bar §7). */}
                  <span>
                    {f.label}
                    {f.required ? <span className="text-destructive"> *</span> : null}
                  </span>
                  {f.type === 'phone' ? (
                    <PhoneField
                      value={value}
                      onChange={(v) => {
                        setAnswer(v);
                        // PhoneField flags too-short numbers inline itself —
                        // just keep the submit gate in step with what it shows.
                        setFieldErrors((e) => ({
                          ...e,
                          [f.name]: isPhoneValueTooShort(v) ? pm.invalid : null,
                        }));
                      }}
                      locale={locale}
                      name={`answer_${f.name}`}
                      required={f.required}
                      ariaLabel={f.label}
                      defaultCountry={f.defaultCountry}
                    />
                  ) : isMulti ? (
                    <textarea
                      name={`answer_${f.name}`}
                      required={f.required}
                      rows={2}
                      placeholder={f.type === 'guests' ? 'guest1@example.com, guest2@example.com' : f.placeholder}
                      value={value}
                      onChange={(e) => setAnswer(e.target.value)}
                      onBlur={(e) => validate(e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2"
                    />
                  ) : (
                    <input
                      name={`answer_${f.name}`}
                      type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : 'text'}
                      required={f.required}
                      placeholder={f.placeholder}
                      value={value}
                      onChange={(e) => setAnswer(e.target.value)}
                      onBlur={(e) => validate(e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2"
                    />
                  )}
                  {/* Phone shows its own inline error for typed-but-short
                      numbers — only the required-empty case renders here. */}
                  {fieldErrors[f.name] && (f.type !== 'phone' || !value.trim()) ? (
                    <span className="text-xs text-destructive">{fieldErrors[f.name]}</span>
                  ) : null}
                </label>
              );
            })}

            <label className="flex flex-col gap-1 text-sm">
              <span>{m.notes}</span>
              <textarea
                name="notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>

            {intakeError ? <p className="text-sm text-destructive">{result!.message}</p> : null}

            <button
              type="submit"
              disabled={pending || Object.values(fieldErrors).some(Boolean)}
              className="bp-btn px-4 py-2 font-semibold transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {pending ? m.confirming : m.confirm}
            </button>
          </form>
        </aside>
      </div>
    );
  }

  // --- Nothing chosen yet: panel + month calendar + the day's times --------
  return (
    <div className="bp-canvas grid gap-6 md:grid-cols-2 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] lg:gap-8">
      <div className="md:col-span-2 lg:col-span-1">{panel}</div>

      {days.length === 0 ? (
        // No calendar at all when the page has no times to put in one: an empty
        // month grid of greyed-out days is a worse answer than the sentence
        // that says why, and the reason codes already distinguish the three
        // cases (config error, calendar unreachable, genuinely nothing).
        <p className="text-muted-foreground md:col-span-2 lg:col-span-2">{emptyCopy}</p>
      ) : (
        <>
          <MonthCalendar
            m={messages}
            monthKey={month}
            availableDayKeys={availableDayKeys}
            todayKey={todayKey}
            selectedDayKey={selectedDay}
            locale={locale}
            weekStartsOn={weekStartsOn}
            minMonthKey={minMonth}
            maxMonthKey={maxMonth}
            onMonthChange={(next) => {
              setNavMonth(next);
              // Drop the explicit pick so the new month falls back to its own
              // first bookable day, rather than showing a column of times from
              // a month that is no longer on screen.
              setPickedDay(null);
            }}
            onSelectDay={setPickedDay}
          />

          <section
            aria-label={bp.timesRegion}
            className="bp-daycol flex min-w-0 flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {dayColumn ? t(bp.timesOn, { day: dayColumn.heading }) : bp.timesRegion}
              </h2>
              {/* 12h / 24h. A two-button radio group, not a switch: neither
                  format is "on", and a switch would have to pick one to be the
                  default state of. A radio group is one tab stop with arrows
                  moving between the options (APG), so the roving tabindex and
                  the arrow handler are part of the role, not decoration. */}
              <div
                role="radiogroup"
                aria-label={bp.timeFormat}
                className="flex rounded-md border border-border p-0.5 text-xs"
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                  e.preventDefault();
                  const group = e.currentTarget;
                  setHour12((v) => !v);
                  // Focus follows the selection, or it would sit on the button
                  // that just became `tabIndex={-1}` and the next Tab would
                  // leave from nowhere.
                  requestAnimationFrame(() =>
                    group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
                  );
                }}
              >
                {([true, false] as const).map((is12) => (
                  <button
                    key={String(is12)}
                    type="button"
                    role="radio"
                    aria-checked={hour12 === is12}
                    tabIndex={hour12 === is12 ? 0 : -1}
                    onClick={() => setHour12(is12)}
                    // 44px, like every other control on the page: a segmented
                    // toggle is a touch target too, and this one sits at the
                    // top of the column a thumb reaches for first.
                    className={`min-h-[44px] rounded-sm px-3 font-medium ${
                      hour12 === is12 ? '' : 'text-muted-foreground'
                    }`}
                    // The accent and ITS OWN contrast colour, not the product's
                    // `accent-foreground`: on a branded page those are two
                    // different palettes, and pairing one's fill with the
                    // other's letters is how a host's accent ends up unreadable.
                    style={
                      hour12 === is12
                        ? { background: 'var(--accent)', color: 'var(--accent-contrast)' }
                        : undefined
                    }
                  >
                    {is12 ? bp.hour12 : bp.hour24}
                  </button>
                ))}
              </div>
            </div>

            {!dayColumn ? (
              <p className="text-sm text-muted-foreground">
                {selectedDay ? bp.noTimesOnDay : bp.pickADay}
              </p>
            ) : (
              <div className="bp-daycol-scroll">
                <div className="bp-slots">
                  {dayColumn.slots.map((s) => {
                    const isGroup = (s.capacity ?? 1) > 1;
                    const full = isGroup && (s.spotsLeft ?? 1) <= 0;
                    return (
                      <button
                        key={s.startUtc}
                        type="button"
                        onClick={() => pick(s)}
                        disabled={full}
                        className="bp-slot text-sm disabled:opacity-50"
                      >
                        <span className="whitespace-nowrap">{s.label}</span>
                        {isGroup ? (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {full ? m.full : t(m.seatsLeft, { n: s.spotsLeft ?? 0 })}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
