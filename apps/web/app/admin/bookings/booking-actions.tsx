'use client';

import { useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import { useToast } from '@/components/toast';
import { cancelBookingAction, confirmBookingAction, declineBookingAction, type CancelScope } from './actions';

type BookingsMessages = BookingMessages['admin']['bookings'];

export function PendingActions({ uid, m }: { uid: string; m: BookingsMessages }) {
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const run = (fn: (u: string) => Promise<{ ok: boolean; message?: string }>, ok: string) =>
    start(async () => {
      const r = await fn(uid);
      if (r.ok) success(ok);
      else error(r.message ?? m.genericError);
    });
  return (
    <div className="flex gap-inline">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(confirmBookingAction, m.confirmedToast)}
        className="rounded-md bg-primary px-field py-tight text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {m.confirm}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(declineBookingAction, m.declinedToast)}
        className="rounded-md border border-destructive px-field py-tight text-sm text-destructive transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {m.decline}
      </button>
    </div>
  );
}

/**
 * Cancel, confirmed inline. On a date of a repeating event (`repeating`) the
 * confirmation asks which dates, the same three choices the MCP's
 * cancel_booking takes, and runs the same code on the API (ADR 0012).
 */
export function CancelAction({ uid, m, repeating = false }: { uid: string; m: BookingsMessages; repeating?: boolean }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const { success, error } = useToast();

  const doCancel = (scope: CancelScope = 'this') =>
    start(async () => {
      const r = await cancelBookingAction(uid, scope);
      setConfirming(false);
      if (r.ok) success(m.cancelledToast);
      else error(r.message ?? m.cancelError);
    });

  const choice = 'rounded-md border border-destructive px-inline py-tight text-destructive disabled:opacity-60';
  return (
    <div className="flex items-center justify-end">
      {confirming && repeating ? (
        <span className="flex flex-wrap items-center justify-end gap-tight text-sm">
          <span className="text-muted-foreground">{m.cancelWhich}</span>
          <button type="button" disabled={pending} onClick={() => doCancel('this')} className={choice}>
            {m.cancelThisDate}
          </button>
          <button type="button" disabled={pending} onClick={() => doCancel('this_and_following')} className={choice}>
            {m.cancelFollowing}
          </button>
          <button type="button" disabled={pending} onClick={() => doCancel('series')} className={choice}>
            {m.cancelWholeSeries}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-border px-inline py-tight">
            {m.no}
          </button>
        </span>
      ) : confirming ? (
        <span className="flex items-center gap-tight text-sm">
          <span className="text-muted-foreground">{m.cancelPrompt}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => doCancel()}
            className="rounded-md border border-destructive px-inline py-tight text-destructive disabled:opacity-60"
          >
            {m.yes}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-border px-inline py-tight">
            {m.no}
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="rounded-md border border-border px-field py-tight text-sm text-muted-foreground transition-transform active:scale-[0.98] hover:border-destructive hover:text-destructive disabled:opacity-60"
        >
          {m.cancel}
        </button>
      )}
    </div>
  );
}
