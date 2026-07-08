'use client';

import { useActionState } from 'react';
import { cancelAction, rescheduleAction } from './actions';

export function ManageActions({ uid, token }: { uid: string; token: string }) {
  const [cancelRes, cancelForm, cancelPending] = useActionState(cancelAction, null);
  const [rsRes, rsForm, rsPending] = useActionState(rescheduleAction, null);

  if (cancelRes?.ok) {
    return (
      <p className="rounded-md border border-border bg-card p-4 text-card-foreground">
        Your booking has been cancelled.
      </p>
    );
  }
  if (rsRes?.ok) {
    return (
      <p className="rounded-md border border-border bg-card p-4 text-card-foreground">
        Your booking has been rescheduled. Check your email for the updated invite.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={rsForm} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
        <input type="hidden" name="uid" value={uid} />
        <input type="hidden" name="token" value={token} />
        <label className="text-sm text-muted-foreground" htmlFor="newStartUtc">
          Reschedule to
        </label>
        <input
          id="newStartUtc"
          name="newStartUtc"
          type="datetime-local"
          className="rounded-md border border-input bg-background px-3 py-2"
        />
        {rsRes && !rsRes.ok ? <p className="text-sm text-destructive">{rsRes.message}</p> : null}
        <button
          type="submit"
          disabled={rsPending}
          className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {rsPending ? 'Rescheduling…' : 'Reschedule'}
        </button>
      </form>

      <form action={cancelForm} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
        <input type="hidden" name="uid" value={uid} />
        <input type="hidden" name="token" value={token} />
        <label className="text-sm text-muted-foreground" htmlFor="reason">
          Cancel this booking
        </label>
        <input
          id="reason"
          name="reason"
          placeholder="Reason (optional)"
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
          {cancelPending ? 'Cancelling…' : 'Cancel booking'}
        </button>
      </form>
    </div>
  );
}
