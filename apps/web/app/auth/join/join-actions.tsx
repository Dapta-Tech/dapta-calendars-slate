'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { acceptInviteAction } from './actions';

type InviteMessages = BookingMessages['admin']['invite'];

function Join({ m, joined }: { m: InviteMessages; joined: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
      {pending ? m.joining : joined ? m.open : m.join}
    </Button>
  );
}

/** Join, or not now. One form, one Server Action; the button locks while it runs. */
export function JoinActions({ accountId, messages: m, joined = false }: { accountId: string; messages: InviteMessages; joined?: boolean }) {
  const [state, action] = useActionState(acceptInviteAction, null);
  return (
    <form action={action} className="flex flex-col gap-field">
      <input type="hidden" name="accountId" value={accountId} />
      {state?.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-field text-sm text-destructive">
          {m.joinFailed}
        </p>
      ) : null}
      <div className="flex flex-col-reverse items-center gap-inline sm:flex-row sm:justify-end">
        <Link href="/admin" className="text-sm text-muted-foreground underline underline-offset-4">
          {m.notNow}
        </Link>
        <Join m={m} joined={joined} />
      </div>
    </form>
  );
}
