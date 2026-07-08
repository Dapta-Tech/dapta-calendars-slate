'use client';

import { useTransition } from 'react';
import { deleteEventTypeAction } from './actions';

export function DeleteButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (confirm('Delete this event type?')) start(() => deleteEventTypeAction(id));
      }}
      className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive transition-transform active:scale-[0.97] disabled:opacity-60"
    >
      {pending ? '…' : 'Delete'}
    </button>
  );
}
