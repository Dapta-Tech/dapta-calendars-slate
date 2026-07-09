import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventTypeForm } from '../event-type-form';

export const dynamic = 'force-dynamic';

export default async function EditEventType({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [et, schedules] = await Promise.all([
    adminApi.getEventType(id),
    adminApi.listSchedules(),
  ]);
  if (!et) notFound();
  const m = getMessages(await getLocale()).admin.eventTypes;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <Link href="/admin/event-types" className="text-sm text-muted-foreground hover:text-foreground">
        ← {m.title}
      </Link>
      <h1 className="mb-6 mt-2 text-3xl font-semibold tracking-tight">{et.title}</h1>
      <EventTypeForm initial={et} schedules={schedules} messages={m} />
    </div>
  );
}
