import { adminApi } from '@/lib/admin-api';
import { ScheduleEditor } from './schedule-editor';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const schedules = await adminApi.listSchedules().catch(() => []);
  const full = await Promise.all(
    schedules.map((s) => adminApi.getSchedule(s.id).catch(() => null)),
  );

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Availability</h1>
      <div className="flex flex-col gap-6">
        {full.filter(Boolean).map((s) => (
          <ScheduleEditor key={s!.id} schedule={s!} />
        ))}
        {schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedules yet.</p>
        ) : null}
      </div>
    </div>
  );
}
