'use client';

import { useTransition } from 'react';
import { cancelBookingAction, confirmBookingAction, declineBookingAction } from './actions';

export function PendingActions({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => confirmBookingAction(uid))}
        className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        Confirm
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => declineBookingAction(uid))}
        className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive disabled:opacity-60"
      >
        Decline
      </button>
    </div>
  );
}

export function CancelAction({ uid }: { uid: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => confirm('Cancel this booking?') && start(() => cancelBookingAction(uid))}
      className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground disabled:opacity-60"
    >
      Cancel
    </button>
  );
}
