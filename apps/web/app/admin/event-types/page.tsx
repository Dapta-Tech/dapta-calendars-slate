import Link from 'next/link';
import { adminApi } from '@/lib/admin-api';
import { EventTypeForm } from './event-type-form';
import { DeleteButton } from './delete-button';

export const dynamic = 'force-dynamic';

export default async function EventTypesPage() {
  const [eventTypes, schedules] = await Promise.all([
    adminApi.listEventTypes(),
    adminApi.listSchedules(),
  ]);

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Event Types</h1>

      <ul className="mb-8 flex flex-col gap-2">
        {eventTypes.map((et) => (
          <li
            key={et.id}
            className="flex items-center justify-between rounded-md border border-border bg-card p-4"
          >
            <span className="flex flex-col">
              <span className="font-medium">
                {et.title}
                {et.hidden ? <span className="ml-2 text-xs text-muted-foreground">(hidden)</span> : null}
              </span>
              <span className="text-sm text-muted-foreground">
                /{et.slug} · {et.lengthMinutes} min
                {et.requiresConfirmation ? ' · needs confirmation' : ''}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Link
                href={`/admin/event-types/${et.id}`}
                className="rounded-md border border-border px-3 py-1 text-sm hover:border-primary"
              >
                Edit
              </Link>
              <DeleteButton id={et.id} />
            </div>
          </li>
        ))}
        {eventTypes.length === 0 ? (
          <li className="text-sm text-muted-foreground">No event types yet — create one below.</li>
        ) : null}
      </ul>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">New event type</h2>
      <EventTypeForm schedules={schedules} />
    </div>
  );
}
