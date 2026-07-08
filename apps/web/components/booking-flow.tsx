'use client';

import { useActionState, useMemo, useState } from 'react';
import { groupSlotsByDay, detectTimeZone, formatSlotDateTime, type Slot } from '@slate/shared';
import { bookAction } from '@/app/[accountCode]/[handle]/[slug]/actions';
import type { BookResult } from '@/lib/api';

interface Props {
  accountCode: string;
  handle: string;
  slug: string;
  slots: Slot[];
  initialTimeZone: string;
}

/**
 * The interactive island: pick a timezone, pick a slot, fill the form, book.
 * Slots are absolute UTC instants, so switching timezone regroups them with no
 * refetch. Submission goes through the bookAction Server Action.
 */
export function BookingFlow({ accountCode, handle, slug, slots, initialTimeZone }: Props) {
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
    return (
      <section className="rounded-md border border-border bg-card p-6 text-card-foreground">
        <h2 className="mb-2 text-xl font-semibold">Booking confirmed</h2>
        <p className="text-muted-foreground">
          {b.title} — {formatSlotDateTime(b.startUtc, timeZone)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          A confirmation was sent to {b.attendee.email}.
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
              <div key={day.dayKey}>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{day.heading}</h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {day.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      type="button"
                      onClick={() => setSelected(s.startUtc)}
                      aria-pressed={selected === s.startUtc}
                      className={
                        'rounded-md border px-2 py-2 text-sm transition-transform active:scale-[0.97] ' +
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
            className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
          >
            <input type="hidden" name="accountCode" value={accountCode} />
            <input type="hidden" name="handle" value={handle} />
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
              className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
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
