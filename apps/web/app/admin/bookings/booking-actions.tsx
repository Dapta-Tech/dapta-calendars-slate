'use client';

import { useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import { cancelBookingAction, confirmBookingAction, declineBookingAction } from './actions';

export function PendingActions({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const run = (fn: (u: string) => Promise<{ ok: boolean; message?: string }>, ok: string) =>
    start(async () => {
      const r = await fn(uid);
      if (r.ok) success(ok);
      else error(r.message ?? 'Something went wrong.');
    });
  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(confirmBookingAction, 'Booking confirmed.')}
        className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        Confirm
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(declineBookingAction, 'Booking declined.')}
        className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        Decline
      </button>
    </div>
  );
}

export function CancelAction({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const { success, error } = useToast();

  const doCancel = () =>
    start(async () => {
      const r = await cancelBookingAction(uid);
      setConfirming(false);
      if (r.ok) success('Booking cancelled.');
      else error(r.message ?? 'Could not cancel the booking.');
    });

  return (
    <div className="flex items-center justify-end">
      {confirming ? (
        <span className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">Cancel?</span>
          <button
            type="button"
            disabled={pending}
            onClick={doCancel}
            className="rounded-md border border-destructive px-2 py-1 text-destructive disabled:opacity-60"
          >
            Yes
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-border px-2 py-1">
            No
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground transition-transform active:scale-[0.98] hover:border-destructive hover:text-destructive disabled:opacity-60"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
