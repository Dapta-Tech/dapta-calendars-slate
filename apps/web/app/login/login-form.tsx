'use client';

import { useActionState } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signInAction } from './actions';

/** Local dev login: email → session (sent as x-slate-email). A successful
 *  action redirects, so only the invalid-email branch returns here. */
export function LoginForm({ messages: m }: { messages: BookingMessages['admin']['login'] }) {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
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
