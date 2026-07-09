import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ScheduleEditor } from './schedule-editor';
import { NewSchedule } from './new-schedule';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const schedules = await adminApi.listSchedules();
  const full = await Promise.all(schedules.map((s) => adminApi.getSchedule(s.id)));
  const ready = full.filter(Boolean);
  const m = getMessages(await getLocale()).admin.availability;

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">{m.title}</h1>
      <p className="mb-6 text-muted-foreground">{m.subtitle}</p>
      <div className="flex flex-col gap-6">
        {ready.map((s) => (
          <ScheduleEditor key={s!.id} schedule={s!} messages={m} />
        ))}
        {ready.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            {m.emptyList}
          </p>
        ) : null}
        <NewSchedule messages={m} />
      </div>
    </div>
  );
}
