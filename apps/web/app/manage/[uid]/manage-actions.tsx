'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { groupSlotsByDay, type BookingMessages, type Slot } from '@slate/shared';
import { cancelAction, rescheduleAction } from './actions';

export function ManageActions({
  uid,
  token,
  slots,
  timeZone,
  messages: m,
}: {
  uid: string;
  token: string;
  slots: Slot[];
  timeZone: string;
  messages: BookingMessages['manage'];
}) {
  const router = useRouter();
  const [cancelRes, cancelForm, cancelPending] = useActionState(cancelAction, null);
  const [rsRes, rsForm, rsPending] = useActionState(rescheduleAction, null);
  const [newStartUtc, setNewStartUtc] = useState('');
  const days = useMemo(() => groupSlotsByDay(slots, timeZone), [slots, timeZone]);

  // On a reschedule conflict (the slot was just taken), re-fetch availability so
  // the picker drops the stale/taken time instead of letting the user retry it.
  useEffect(() => {
    if (rsRes && !rsRes.ok) {
      setNewStartUtc('');
      router.refresh();
    }
  }, [rsRes, router]);

  if (cancelRes?.ok) {
    return (
      <p className="rounded-md border border-border bg-card p-4 text-card-foreground">
        {m.cancelled}
      </p>
    );
  }
  if (rsRes?.ok) {
    return (
      <p className="rounded-md border border-border bg-card p-4 text-card-foreground">
        {m.rescheduled}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={rsForm} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
        <input type="hidden" name="uid" value={uid} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="newStartUtc" value={newStartUtc} />
        <span className="text-sm text-muted-foreground">{m.rescheduleTo}</span>
        {days.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.noOpenTimes}</p>
        ) : (
          <div className="flex max-h-64 flex-col gap-3 overflow-y-auto pr-1">
            {days.map((day) => (
              <div key={day.dayKey}>
                <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{day.heading}</h3>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {day.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      type="button"
                      onClick={() => setNewStartUtc(s.startUtc)}
                      aria-pressed={newStartUtc === s.startUtc}
                      className={
                        'rounded-md border px-2 py-1.5 text-xs transition-transform active:scale-[0.98] ' +
                        (newStartUtc === s.startUtc
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:border-primary')
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
        {rsRes && !rsRes.ok ? <p className="text-sm text-destructive">{rsRes.message}</p> : null}
        <button
          type="submit"
          disabled={rsPending || !newStartUtc}
          className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {rsPending ? m.rescheduling : m.reschedule}
        </button>
      </form>

      <form action={cancelForm} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
        <input type="hidden" name="uid" value={uid} />
        <input type="hidden" name="token" value={token} />
        <label className="text-sm text-muted-foreground" htmlFor="reason">
          {m.cancelThis}
        </label>
        <input
          id="reason"
          name="reason"
          placeholder={m.cancelReason}
          className="rounded-md border border-input bg-background px-3 py-2"
        />
        {cancelRes && !cancelRes.ok ? (
          <p className="text-sm text-destructive">{cancelRes.message}</p>
        ) : null}
        <button
          type="submit"
          disabled={cancelPending}
          className="rounded-md border border-destructive px-4 py-2 font-semibold text-destructive transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {cancelPending ? m.cancelling : m.cancel}
        </button>
      </form>
    </div>
  );
}
