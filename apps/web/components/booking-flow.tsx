'use client';

import { useActionState, useMemo, useState } from 'react';
import {
  groupSlotsByDay,
  formatSlotDateTime,
  getMessages,
  isReservedFieldName,
  t,
  validateBookingFieldValue,
  type DisplaySlot,
  type Slot,
} from '@slate/shared';

/** Mirror of the server's attendee-email rule — catches the 400 before a
 *  round-trip, so a typo never costs the visitor their filled-in form. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import type { BookingField } from '@slate/types';
import { bookAction, reserveAction } from '@/app/[accountCode]/[handle]/[slug]/actions';
import { type BookResult } from '@/lib/api';
import { signupHref } from '@/lib/growth';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { PhoneField, isPhoneValueTooShort } from '@/components/ui/phone-field';

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
}

interface Hold {
  uid: string;
  expiresAt: string;
}

/**
 * The interactive island: pick a timezone, pick a slot (which places a soft
 * HOLD), fill the form, book. Slots are absolute UTC instants (tz switch
 * regroups with no refetch). Errors surface by HTTP status: 409 slot-taken and
 * 410 hold-expired both offer a Retry (R22 error+retry). Branding renders via
 * the ancestor `.branded-surface` classes + `--bp-*` vars (preview == prod).
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
}: Props) {
  const m = getMessages(locale).booking;
  const pm = getMessages(locale).phonePicker;
  // Reserved names (name/email/notes) are fixed attendee fields this form
  // always asks by itself — a legacy custom question reusing one would ask
  // the attendee twice (QA3 fix 3).
  const visibleFields = useMemo(
    () => bookingFields.filter((f) => !isReservedFieldName(f.name)),
    [bookingFields],
  );
  const [timeZone, setTimeZone] = useState(initialTimeZone);
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

  const days = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);

  async function pick(slot: DisplaySlot) {
    setSelected(slot.startUtc);
    // The last attempt's error stays dismissed: picking a slot used to clear
    // the flag while `result` still held that error, so choosing a new time
    // after a conflict re-rendered the conflict card straight back.
    setDismissedResult(result);
    setHoldError(null);
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

  function retry() {
    setSelected(null);
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
      : formatSlotDateTime(b.startUtc, timeZone);
    // Dropped rather than interpolated empty: both strings end in the address,
    // so a missing one renders "A confirmation was sent to ." — worse than
    // saying nothing.
    const attendeeEmail = b.attendee?.email;
    return (
      <div>
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
            <a
              href={b.manageUrl}
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
      <section className="bp-card border border-destructive bg-card p-6">
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
      <section className="bp-card border border-destructive bg-card p-6">
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

  return (
    <div className="bp-canvas grid gap-8 md:grid-cols-[1fr_320px]">
      <section aria-label="Available times">
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="tz" className="text-sm text-muted-foreground">
            {m.timezone}
          </label>
          {/* Themed combobox, not the native <select>: the OS popup for ~400
              zones is un-brandable and covers the screen (QA2 fix 1). */}
          <TimeZoneSelect
            id="tz"
            value={timeZone}
            onChange={setTimeZone}
            locale={locale}
            ariaLabel={m.timezone}
            className="w-64 max-w-full"
          />
        </div>

        {days.length === 0 ? (
          <p className="text-muted-foreground">
            {emptyReason === 'CALENDAR_UNAVAILABLE'
              ? m.timesUnavailable
              : emptyReason
                ? m.noTimesNow
                : m.noSlots}
          </p>
        ) : (
          // Page-scroll, no inner scroll region (Design Quality Bar §2): the list
          // flows in the page so there's no native scrollbar or mid-row cut, and
          // the day headers stay sticky for context.
          <div className="flex flex-col gap-4">
            {days.map((day) => (
              <div key={day.dayKey} className="bp-day">
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{day.heading}</h3>
                <div className="bp-slots">
                  {day.slots.map((s) => {
                    const isGroup = (s.capacity ?? 1) > 1;
                    const full = isGroup && (s.spotsLeft ?? 1) <= 0;
                    return (
                      <button
                        key={s.startUtc}
                        type="button"
                        onClick={() => pick(s)}
                        aria-pressed={selected === s.startUtc}
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
            ))}
          </div>
        )}
      </section>

      <aside aria-label="Your details" className="md:sticky md:top-6 md:self-start">
        {selected ? (
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

            <p className="text-sm text-muted-foreground">{formatSlotDateTime(selected, timeZone)}</p>
            {hold ? (
              <p className="text-xs text-muted-foreground">
                {t(m.heldUntil, {
                  time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(hold.expiresAt)),
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
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            {m.selectTime}
          </p>
        )}
      </aside>
    </div>
  );
}
