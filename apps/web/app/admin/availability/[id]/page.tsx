import { notFound } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi, ApiError } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ScheduleEditor } from '../schedule-editor';

export const dynamic = 'force-dynamic';

export default async function EditSchedule({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // getSchedule throws ApiError on 404 (e.g. a stale/deleted id, or the removed
  // /new path now caught by [id]) — turn that into a clean 404, not a crash.
  const schedule = await adminApi.getSchedule(id).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  if (!schedule) notFound();
  const locale = await getLocale();
  const m = getMessages(locale).admin.availability;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10 sm:px-8">
      <ScheduleEditor
        schedule={schedule}
        messages={m}
        backHref="/admin/availability"
        backLabel={m.title}
        locale={locale}
      />
    </div>
  );
}
