'use client';

import { useState, useTransition } from 'react';
import { cancelBookingAction, confirmBookingAction, declineBookingAction } from './actions';

export function PendingActions({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: (u: string) => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn(uid);
      setErr(r.ok ? null : (r.message ?? 'Something went wrong.'));
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(confirmBookingAction)}
          className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(declineBookingAction)}
          className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          Decline
        </button>
      </div>
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
    </div>
  );
}

export function CancelAction({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doCancel = () =>
    start(async () => {
      const r = await cancelBookingAction(uid);
      setConfirming(false);
      setErr(r.ok ? null : (r.message ?? 'Could not cancel the booking.'));
    });

  return (
    <div className="flex flex-col items-end gap-1">
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
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
    </div>
  );
}
