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
    <div className="mx-auto max-w-4xl px-8 pb-10">
      <EventTypeForm
        initial={et}
        schedules={schedules}
        messages={m}
        backHref="/admin/event-types"
        backLabel={m.title}
        heading={et.title}
      />
    </div>
  );
}
