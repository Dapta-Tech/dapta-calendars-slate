import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventTypeForm } from '../event-type-form';

export const dynamic = 'force-dynamic';

export default async function NewEventType() {
  const [schedules, connections, locale] = await Promise.all([
    adminApi.listSchedules(),
    adminApi.listConnections(),
    getLocale(),
  ]);
  const m = getMessages(locale).admin.eventTypes;
  // A brand-new event has no teamId yet — it starts as a personal event, so
  // the calendars section is always relevant here (team assignment happens
  // after creation on the edit screen, where it's hidden for team events).

  return (
    <div className="mx-auto max-w-4xl px-8 pb-10">
      <EventTypeForm
        schedules={schedules}
        messages={m}
        connections={connections}
        redirectOnSuccess="/admin/event-types"
        backHref="/admin/event-types"
        backLabel={m.title}
        heading={m.newEventType}
      />
    </div>
  );
}
