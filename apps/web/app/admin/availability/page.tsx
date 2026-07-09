import { adminApi } from '@/lib/admin-api';
import { ScheduleEditor } from './schedule-editor';
import { NewSchedule } from './new-schedule';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const schedules = await adminApi.listSchedules().catch(() => []);
  const full = await Promise.all(schedules.map((s) => adminApi.getSchedule(s.id).catch(() => null)));
  const ready = full.filter(Boolean);

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Availability</h1>
      <p className="mb-6 text-muted-foreground">
        Weekly hours and date overrides. Add multiple ranges per day (e.g. 9–12 and 14–18).
      </p>
      <div className="flex flex-col gap-6">
        {ready.map((s) => (
          <ScheduleEditor key={s!.id} schedule={s!} />
        ))}
        {ready.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            No schedules yet — create one to set your weekly hours.
          </p>
        ) : null}
        <NewSchedule />
      </div>
    </div>
  );
}
