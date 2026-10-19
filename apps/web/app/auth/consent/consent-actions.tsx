'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { decideConsentAction } from './actions';

type ConsentMessages = BookingMessages['admin']['oauthConsent'];

function Choice({ decision, label, variant, m }: { decision: 'approve' | 'deny'; label: string; variant: 'default' | 'soft'; m: ConsentMessages }) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get('decision') === decision;
  return (
    <Button type="submit" name="decision" value={decision} size="lg" variant={variant} disabled={pending} className="w-full sm:w-auto">
      {mine ? m.working : label}
    </Button>
  );
}

/**
 * Allow and Deny, one form, one Server Action. Both buttons lock while the
 * answer is in flight, so a double click cannot send two answers; the API
 * refuses a second one anyway (the ticket is single-use).
 */
export function ConsentActions({ uid, canApprove, messages: m }: { uid: string; canApprove: boolean; messages: ConsentMessages }) {
  const [state, action] = useActionState(decideConsentAction, null);
  return (
    <form action={action} className="flex flex-col gap-field">
      <input type="hidden" name="uid" value={uid} />
      {state?.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-field text-sm text-destructive">
          {m.errorBody}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-inline sm:flex-row sm:justify-end">
        <Choice decision="deny" label={m.deny} variant="soft" m={m} />
        {canApprove ? <Choice decision="approve" label={m.approve} variant="default" m={m} /> : null}
      </div>
    </form>
  );
}
