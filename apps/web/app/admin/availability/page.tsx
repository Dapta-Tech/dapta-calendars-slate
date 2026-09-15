import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';
import { DeleteScheduleButton } from './delete-schedule-button';
import { NewScheduleButton } from './new-schedule-button';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const schedules = await adminApi.listSchedules();
  const locale = await getLocale();
  const admin = getMessages(locale).admin;
  const m = admin.availability;

  const newButton = <NewScheduleButton messages={m} />;

  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      {/* One CTA per screen: top-right Create only with rows; the empty state
          below owns the sole centered CTA. */}
      <PageHeader
        title={m.title}
        subtitle={m.subtitle}
        action={schedules.length > 0 ? newButton : undefined}
      />

      {schedules.length > 0 ? (
        <ul className="flex flex-col gap-inline">
          {schedules.map((s) => (
            <li
              key={s.id}
              className="flex flex-col gap-field rounded-xl border border-border bg-card p-card sm:flex-row sm:items-center sm:justify-between"
            >
              <Link href={`/admin/availability/${s.id}`} className="flex min-w-0 items-center gap-field">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden>
                  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7.5V12l3 2" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium hover:text-primary">{s.name}</span>
                  <span className="truncate text-sm text-muted-foreground">{s.timeZone}</span>
                </span>
              </Link>
              <div className="flex shrink-0 items-center gap-inline">
                <Link
                  href={`/admin/availability/${s.id}`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
                  aria-label={`${admin.common.edit} · ${s.name}`}
                >
                  {admin.common.edit}
                </Link>
                <DeleteScheduleButton id={s.id} name={s.name} messages={m} locale={locale} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-field rounded-xl border border-dashed border-border p-group text-center sm:p-section">
          <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" />
          </svg>
          <p className="max-w-sm text-sm text-muted-foreground">{m.emptyList}</p>
          {newButton}
        </div>
      )}
    </div>
  );
}
