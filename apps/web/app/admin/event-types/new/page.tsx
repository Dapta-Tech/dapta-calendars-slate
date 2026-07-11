import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventTypeForm } from '../event-type-form';

export const dynamic = 'force-dynamic';

export default async function NewEventType() {
  const [schedules, locale] = await Promise.all([adminApi.listSchedules(), getLocale()]);
  const m = getMessages(locale).admin.eventTypes;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <Link href="/admin/event-types" className="text-sm text-muted-foreground hover:text-foreground">
        ← {m.title}
      </Link>
      <h1 className="mb-6 mt-2 text-3xl font-semibold tracking-tight">{m.newEventType}</h1>
      <EventTypeForm schedules={schedules} messages={m} redirectOnSuccess="/admin/event-types" />
    </div>
  );
}
