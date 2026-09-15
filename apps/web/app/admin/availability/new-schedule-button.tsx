'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BookingMessages } from '@slate/shared';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { createScheduleAction } from './actions';

type AvailabilityMessages = BookingMessages['admin']['availability'];

/**
 * Create-a-schedule in ONE step: there's no separate "name it" screen — this
 * creates a schedule pre-seeded with Mon–Fri 09:00–17:00 and drops you straight
 * into its editor, where you rename and adjust hours. (Felipe: two screens for
 * this made no sense.)
 */
export function NewScheduleButton({ messages: m }: { messages: AvailabilityMessages }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { error } = useToast();

  const create = () =>
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const r = await createScheduleAction(m.newSchedule, tz);
      if (r.ok && r.id) router.push(`/admin/availability/${r.id}`);
      else error(r.message ?? m.saveError);
    });

  return (
    // `Button` already carries the disabled recipe this used to inline, including
    // the `disabled:shadow-none` that stops a disabled accent fill from wearing
    // the rim `globals.css` puts on every `bg-primary`.
    <Button size="lg" onClick={create} disabled={pending}>
      {pending ? m.saving : m.newSchedule}
    </Button>
  );
}
