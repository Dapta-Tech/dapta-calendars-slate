'use client';

import { useActionState } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RETURN_TO_PARAM } from '@/lib/return-to';
import { signInAction } from './actions';

/** Local dev login: email → session (sent as x-slate-email). A successful
 *  action redirects, so only the invalid-email branch returns here. `next` is
 *  the page the sign-in returns to, already read through `safeReturnTo`; the
 *  action reads it through the same check again, since a form field is the
 *  browser's to change. */
export function LoginForm({
  messages: m,
  next,
}: {
  messages: BookingMessages['admin']['login'];
  next?: string | null;
}) {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      {next ? <input type="hidden" name={RETURN_TO_PARAM} value={next} /> : null}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.emailLabel}</span>
        <Input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          placeholder={m.emailPlaceholder}
          aria-invalid={state?.error ? true : undefined}
          className="min-h-[44px]"
        />
      </label>
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {m.emailInvalid}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {m.continue}
      </Button>
    </form>
  );
}
