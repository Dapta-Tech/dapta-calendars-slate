'use client';

import { useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteScheduleAction } from './actions';

type AvailabilityMessages = BookingMessages['admin']['availability'];

/**
 * Delete a schedule from its list row.
 *
 * A2 (#112): this used to swap itself for a Yes/No pair in the same corner of
 * the row. Nothing trapped focus, nothing was announced, and the pair appeared
 * where the pointer already was — so the second click landed on "Yes" as often
 * as it landed on the button the person meant. It now asks through the real
 * dialog, and the question names the schedule.
 */
export function DeleteScheduleButton({
  id,
  name,
  messages: m,
  locale,
}: {
  id: string;
  name: string;
  messages: AvailabilityMessages;
  /** Active admin locale — the ConfirmDialog's own confirm/cancel copy. */
  locale?: Locale;
}) {
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  const ask = async () => {
    const ok = await confirm({
      title: m.deleteTitle,
      message: t(m.deleteBody, { name }),
      confirmLabel: m.deleteSchedule,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteScheduleAction(id);
      if (r.ok) success(m.deletedToast);
      else error(r.message ?? m.deleteError);
    });
  };

  return (
    <>
      <Button
        variant="destructive"
        size="lg"
        disabled={pending}
        aria-label={`${m.deleteSchedule} · ${name}`}
        onClick={() => void ask()}
      >
        {m.deleteSchedule}
      </Button>
      {dialog}
    </>
  );
}
