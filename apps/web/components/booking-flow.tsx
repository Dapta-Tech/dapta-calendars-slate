'use client';

import { useActionState, useMemo, useState } from 'react';
import { groupSlotsByDay, detectTimeZone, formatSlotDateTime, type Slot } from '@slate/shared';
import type { BookingField } from '@slate/types';
import { bookAction } from '@/app/[accountCode]/[handle]/[slug]/actions';
import type { BookResult } from '@/lib/api';

interface Props {
  accountCode: string;
  /** Member handle (personal) or team slug (team). */
  ownerSlug: string;
  slug: string;
  slots: Slot[];
  bookingFields: BookingField[];
  initialTimeZone: string;
  mode?: 'personal' | 'team';
  /** Branding axes (slotLayout/dayGroup/slotSelect) — from the host's studio. */
  style?: Record<string, string> | null;
}

/**
 * The interactive island: pick a timezone, pick a slot, fill the form, book.
 * Slots are absolute UTC instants, so switching timezone regroups them with no
 * refetch. Submission goes through the bookAction Server Action.
 */
export function BookingFlow({
  accountCode,
  ownerSlug,
  slug,
  slots,
  bookingFields,
  initialTimeZone,
  mode = 'personal',
  style,
}: Props) {
  const slotLayout = style?.slotLayout ?? 'grid';
  const dayGroup = style?.dayGroup ?? 'flat';
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, formAction, pending] = useActionState<BookResult | null, FormData>(
    bookAction,
    null,
  );

  // On the client, prefer the visitor's own detected zone once mounted.
  const days = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);

  if (result?.ok && result.booking) {
    const b = result.booking;
    const pending = b.status === 'pending';
    return (
      <section className="rounded-md border border-border bg-card p-6 text-card-foreground">
        <h2 className="mb-2 text-xl font-semibold">
          {pending ? 'Booking requested' : 'Booking confirmed'}
        </h2>
        <p className="text-muted-foreground">
          {b.title} — {formatSlotDateTime(b.startUtc, timeZone)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {pending
            ? `Awaiting the host’s confirmation. We’ll email ${b.attendee.email} once it’s confirmed.`
            : `A confirmation was sent to ${b.attendee.email}.`}
        </p>
      </section>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_320px]">
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
          <div className="flex max-h-[28rem] flex-col gap-6 overflow-y-auto pr-2">
            {days.map((day) => (
              <div
                key={day.dayKey}
                className={dayGroup === 'boxed' ? 'rounded-md border border-border p-3' : ''}
                style={dayGroup === 'boxed' ? { borderRadius: 'var(--bp-radius, 0.5rem)' } : undefined}
              >
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{day.heading}</h3>
                <div
                  className={
                    slotLayout === 'list' ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-3 gap-2 sm:grid-cols-4'
                  }
                >
                  {day.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      type="button"
                      onClick={() => setSelected(s.startUtc)}
                      aria-pressed={selected === s.startUtc}
                      style={{ borderRadius: 'var(--bp-btn-radius, 0.5rem)' }}
                      className={
                        'border px-2 py-2 text-sm transition-transform active:scale-[0.97] ' +
                        (selected === s.startUtc
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card hover:border-primary')
                      }
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
          <form
            action={formAction}
            style={{ borderRadius: 'var(--bp-radius, 0.5rem)' }}
            className="flex flex-col gap-3 border border-border bg-card p-4"
          >
            <input type="hidden" name="accountCode" value={accountCode} />
            <input type="hidden" name="ownerSlug" value={ownerSlug} />
            <input type="hidden" name="kind" value={mode} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="startUtc" value={selected} />
            <input type="hidden" name="timeZone" value={timeZone} />

            <p className="text-sm text-muted-foreground">
              {formatSlotDateTime(selected, timeZone)}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Your name
              <input
                name="name"
                required
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Your email
              <input
                name="email"
                type="email"
                required
                className="rounded-md border border-input bg-background px-3 py-2"
              />
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
              <textarea
                name="notes"
                rows={2}
                className="rounded-md border border-input bg-background px-3 py-2"
              />
            </label>

            {result && !result.ok ? (
              <p className="text-sm text-destructive">{result.message}</p>
            ) : null}

            <button
              type="submit"
              disabled={pending}
              style={{ borderRadius: 'var(--bp-btn-radius, 0.5rem)' }}
              className="bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
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
