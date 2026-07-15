import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventTypeForm } from '../event-type-form';

export const dynamic = 'force-dynamic';

export default async function NewEventType({
  searchParams,
}: {
  searchParams: Promise<{ teamId?: string }>;
}) {
  // ?teamId=… creates a TEAM event (QA2 fix 5): the team page's "New team
  // event" button lands here; the form gains the scheduling-method + hosts
  // section and returns to the team page on success.
  const { teamId } = await searchParams;
  const [schedules, connections, locale] = await Promise.all([
    adminApi.listSchedules(),
    adminApi.listConnections(),
    getLocale(),
  ]);
  const msgs = getMessages(locale);
  const m = msgs.admin.eventTypes;
  // The calendars section applies to PERSONAL events (team events resolve
  // their hosts' calendars at booking time), so it's hidden in team mode —
  // handled below via `connections={teamId ? undefined : connections}`.

  const teamMembers = teamId
    ? (await adminApi.teamMembers(teamId)).map((tm) => ({
        memberId: tm.member_id,
        displayName: tm.display_name,
      }))
    : undefined;

  return (
    <div className="mx-auto max-w-4xl px-8 pb-10">
      <EventTypeForm
        schedules={schedules}
        messages={m}
        scheduling={teamId ? msgs.scheduling : undefined}
        teamMembers={teamMembers}
        teamId={teamId}
        connections={teamId ? undefined : connections}
        redirectOnSuccess={teamId ? `/admin/teams/${teamId}` : '/admin/event-types'}
        backHref={teamId ? `/admin/teams/${teamId}` : '/admin/event-types'}
        backLabel={teamId ? msgs.admin.teams.teamEventTypes : m.title}
        heading={teamId ? msgs.admin.teams.newTeamEvent : m.newEventType}
      />
    </div>
  );
}
