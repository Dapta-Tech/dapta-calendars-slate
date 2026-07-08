'use client';

import { useActionState, useMemo, useState } from 'react';
import { groupSlotsByDay, detectTimeZone, formatSlotDateTime, type Slot } from '@slate/shared';
import type { BookingField } from '@slate/types';
import { bookAction } from '@/app/[accountCode]/[handle]/[slug]/actions';
import { postReservation, type BookResult } from '@/lib/api';

interface Props {
  accountCode: string;
  /** Member handle (personal) or team slug (team). */
  ownerSlug: string;
  slug: string;
  slots: Slot[];
  bookingFields: BookingField[];
  initialTimeZone: string;
  mode?: 'personal' | 'team';
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
  bookingFields,
  initialTimeZone,
  mode = 'personal',
}: Props) {
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [selected, setSelected] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [result, formAction, pending] = useActionState<BookResult | null, FormData>(bookAction, null);

  const days = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);

  async function pick(startUtc: string) {
    setSelected(startUtc);
    setDismissed(false);
    setHoldError(null);
    setHold(null);
    // Team events round-robin the host at booking time — no per-host hold.
    if (mode !== 'personal') return;
    const r = await postReservation({ accountCode, handle: ownerSlug, slug, startUtc });
    if (r.ok && r.reservationUid) setHold({ uid: r.reservationUid, expiresAt: r.expiresAt! });
    else setHoldError(r.message ?? 'Could not hold this time.');
  }

  function retry() {
    setSelected(null);
    setHold(null);
    setHoldError(null);
    setDismissed(true);
  }

  // --- Confirmed ----------------------------------------------------------
  if (result?.ok && result.booking) {
    const b = result.booking;
    const isPending = b.status === 'pending';
    return (
      <section className="bp-card border border-border bg-card p-6 text-card-foreground">
        <h2 className="mb-2 text-xl font-semibold">
          {isPending ? 'Booking requested' : 'Booking confirmed'}
        </h2>
        <p className="text-muted-foreground">
          {b.title} — {formatSlotDateTime(b.startUtc, timeZone)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isPending
            ? `Awaiting the host’s confirmation. We’ll email ${b.attendee.email} once it’s confirmed.`
            : `A confirmation was sent to ${b.attendee.email}.`}
        </p>
        {b.manageUrl ? (
          <a
            href={b.manageUrl}
            className="mt-4 inline-block text-sm text-primary underline underline-offset-4"
          >
            Manage your booking (reschedule or cancel) →
          </a>
        ) : null}
      </section>
    );
  }

  const conflict = result && !result.ok && !dismissed && (result.status === 409 || result.status === 410);
  const intakeError = result && !result.ok && !dismissed && result.status === 400;

  // --- Conflict (409/410): R22 error + retry ------------------------------
  if (conflict) {
    return (
      <section className="bp-card border border-destructive bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">
          {result!.status === 410 ? 'Your hold expired' : 'That time was just taken'}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">{result!.message}</p>
        <button
          type="button"
          onClick={retry}
          className="bp-btn px-4 py-2 font-semibold transition-transform active:scale-[0.98]"
        >
          Pick another time
        </button>
      </section>
    );
  }

  return (
    <div className="bp-canvas grid gap-8 md:grid-cols-[1fr_320px]">
      <section aria-label="Available times">
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="tz" className="text-sm text-muted-foreground">
            Timezone
          </label>
          <select
            id="tz"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="rounded-md border border-input bg-card px-2 py-1 text-sm"
          >
            {[timeZone, detectTimeZone(), 'UTC']
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
          </select>
        </div>

        {days.length === 0 ? (
          <p className="text-muted-foreground">No available times in this range.</p>
        ) : (
          <div className="flex max-h-[28rem] flex-col overflow-y-auto pr-2">
            {days.map((day) => (
              <div key={day.dayKey} className="bp-day">
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{day.heading}</h3>
                <div className="bp-slots">
                  {day.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      type="button"
                      onClick={() => pick(s.startUtc)}
                      aria-pressed={selected === s.startUtc}
                      className="bp-slot text-sm"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside aria-label="Your details">
        {selected ? (
          <form action={formAction} className="bp-card flex flex-col gap-3 border border-border bg-card p-4">
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
                Held until {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(hold.expiresAt))}
              </p>
            ) : holdError ? (
              <p className="text-xs text-destructive">{holdError}</p>
            ) : null}

            <label className="flex flex-col gap-1 text-sm">
              Your name
              <input name="name" required className="rounded-md border border-input bg-background px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Your email
              <input name="email" type="email" required className="rounded-md border border-input bg-background px-3 py-2" />
            </label>

            {bookingFields.map((f) => (
              <label key={f.name} className="flex flex-col gap-1 text-sm">
                {f.label}
                {f.required ? <span className="text-destructive"> *</span> : null}
                {f.type === 'textarea' ? (
                  <textarea
                    name={`answer_${f.name}`}
                    required={f.required}
                    rows={2}
                    placeholder={f.placeholder}
                    className="rounded-md border border-input bg-background px-3 py-2"
                  />
                ) : (
                  <input
                    name={`answer_${f.name}`}
                    type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : 'text'}
                    required={f.required}
                    placeholder={f.placeholder}
                    className="rounded-md border border-input bg-background px-3 py-2"
                  />
                )}
              </label>
            ))}

            <label className="flex flex-col gap-1 text-sm">
              Notes (optional)
              <textarea name="notes" rows={2} className="rounded-md border border-input bg-background px-3 py-2" />
            </label>

            {intakeError ? <p className="text-sm text-destructive">{result!.message}</p> : null}

            <button
              type="submit"
              disabled={pending}
              className="bp-btn px-4 py-2 font-semibold transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {pending ? 'Confirming…' : 'Confirm booking'}
            </button>
          </form>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            Select a time to continue.
          </p>
        )}
      </aside>
    </div>
  );
}
