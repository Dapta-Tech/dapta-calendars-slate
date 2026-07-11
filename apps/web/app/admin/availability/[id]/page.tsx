import { notFound } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ScheduleEditor } from '../schedule-editor';

export const dynamic = 'force-dynamic';

export default async function EditSchedule({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schedule = await adminApi.getSchedule(id);
  if (!schedule) notFound();
  const m = getMessages(await getLocale()).admin.availability;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <ScheduleEditor schedule={schedule} messages={m} backHref="/admin/availability" backLabel={m.title} />
    </div>
  );
}
