import { getMessages } from '@slate/shared';
import { adminApi, describeCalendarLink } from '@/lib/admin-api';
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
  // the calendar-link line is always relevant here (team assignment happens
  // after creation on the edit screen, where the line is hidden for team events).
  const calendarLink = describeCalendarLink(connections);

  return (
    <div className="mx-auto max-w-4xl px-8 pb-10">
      <EventTypeForm
        schedules={schedules}
        messages={m}
        calendarLink={calendarLink}
        redirectOnSuccess="/admin/event-types"
        backHref="/admin/event-types"
        backLabel={m.title}
        heading={m.newEventType}
      />
    </div>
  );
}
