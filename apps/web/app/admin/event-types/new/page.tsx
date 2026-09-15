import { unstable_rethrow } from 'next/navigation';
import { getMessages } from '@slate/shared';
import type { CrmPropertyCatalog } from '@slate/types';
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
  const [schedules, connections, locale, crm] = await Promise.all([
    adminApi.listSchedules(),
    adminApi.listConnections(),
    getLocale(),
    crmCatalog(),
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
    <div className="mx-auto max-w-4xl px-gutter sm:px-gutter-wide pb-gutter-y">
      <EventTypeForm
        schedules={schedules}
        messages={m}
        locationLabels={msgs.location}
        scheduling={teamId ? msgs.scheduling : undefined}
        teamMembers={teamMembers}
        teamId={teamId}
        connections={teamId ? undefined : connections}
        redirectOnSuccess={teamId ? `/admin/teams/${teamId}` : '/admin/event-types'}
        backHref={teamId ? `/admin/teams/${teamId}` : '/admin/event-types'}
        backLabel={teamId ? msgs.admin.teams.teamEventTypes : m.title}
        heading={teamId ? msgs.admin.teams.newTeamEvent : m.newEventType}
        crmCatalog={crm}
        locale={locale}
      />
    </div>
  );
}

/**
 * The CRM contact-property catalog for the mapping section (H2 / #108).
 *
 * Failed SEPARATELY from everything else on the page, and to `null`: the
 * mapping section is one part of the editor, and a CRM that cannot be reached
 * must not blank the form a host came here to edit. `null` renders no section
 * at all, which is also what a deployment with no adapter gets.
 */
async function crmCatalog(): Promise<CrmPropertyCatalog | undefined> {
  try {
    return await adminApi.crmContactProperties();
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return undefined;
  }
}
