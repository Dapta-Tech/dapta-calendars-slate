import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ScheduleEditor } from './schedule-editor';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const schedules = await adminApi.listSchedules();
  const full = await Promise.all(schedules.map((s) => adminApi.getSchedule(s.id)));
  const ready = full.filter(Boolean);
  const m = getMessages(await getLocale()).admin.availability;

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">{m.title}</h1>
          <p className="text-muted-foreground">{m.subtitle}</p>
        </div>
        <Link
          href="/admin/availability/new"
          className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
        >
          {m.newSchedule}
        </Link>
      </div>
      {ready.length > 0 ? (
        <div className="flex flex-col gap-6">
          {ready.map((s) => (
            <ScheduleEditor key={s!.id} schedule={s!} messages={m} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-10 text-center">
          <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" />
          </svg>
          <p className="max-w-sm text-sm text-muted-foreground">{m.emptyList}</p>
          <Link
            href="/admin/availability/new"
            className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {m.newSchedule}
          </Link>
        </div>
      )}
    </div>
  );
}
