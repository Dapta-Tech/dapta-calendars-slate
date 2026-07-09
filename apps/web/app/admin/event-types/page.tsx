import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventTypeForm } from './event-type-form';
import { DeleteButton } from './delete-button';

export const dynamic = 'force-dynamic';

export default async function EventTypesPage() {
  const [eventTypes, schedules] = await Promise.all([
    adminApi.listEventTypes(),
    adminApi.listSchedules(),
  ]);
  const admin = getMessages(await getLocale()).admin;
  const m = admin.eventTypes;

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">{m.title}</h1>

      <ul className="mb-8 flex flex-col gap-2">
        {eventTypes.map((et) => (
          <li
            key={et.id}
            className="flex items-center justify-between rounded-md border border-border bg-card p-4"
          >
            <span className="flex flex-col">
              <span className="font-medium">
                {et.title}
                {et.hidden ? <span className="ml-2 text-xs text-muted-foreground">({m.hidden})</span> : null}
              </span>
              <span className="text-sm text-muted-foreground">
                /{et.slug} · {et.lengthMinutes} {m.minSuffix}
                {et.requiresConfirmation ? ` · ${m.needsConfirmation}` : ''}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Link
                href={`/admin/event-types/${et.id}`}
                className="rounded-md border border-border px-3 py-1 text-sm hover:border-primary"
              >
                {admin.common.edit}
              </Link>
              <DeleteButton id={et.id} />
            </div>
          </li>
        ))}
        {eventTypes.length === 0 ? (
          <li className="text-sm text-muted-foreground">{m.emptyList}</li>
        ) : null}
      </ul>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{m.newEventType}</h2>
      <EventTypeForm schedules={schedules} messages={m} />
    </div>
  );
}
