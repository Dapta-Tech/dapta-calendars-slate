import { notFound } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi, ApiError } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { EventRowActions } from '../event-row-actions';
import { EventTypeForm } from '../event-type-form';

export const dynamic = 'force-dynamic';

export default async function EditEventType({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  // getEventType throws ApiError on 404 (stale/deleted id) — render a clean 404.
  const [et, schedules, connections] = await Promise.all([
    adminApi.getEventType(id).catch((e) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    adminApi.listSchedules(),
    adminApi.listConnections(),
  ]);
  if (!et) notFound();
  const msgs = getMessages(await getLocale());
  const m = msgs.admin.eventTypes;

  // Team events get the scheduling-method selector + per-host controls; load the
  // team's members so their names render in the host list.
  const teamMembers = et.teamId
    ? (await adminApi.teamMembers(et.teamId)).map((tm) => ({
        memberId: tm.member_id,
        displayName: tm.display_name,
      }))
    : undefined;

  // Contextual back (QA3 fix 4b): team pages link here with ?from=team:<id>,
  // so the back affordance returns to that team, not the Events list. Only
  // honored when the id actually matches this event's team.
  const fromTeamId = from?.startsWith('team:') ? from.slice('team:'.length) : null;
  const backToTeam = fromTeamId !== null && et.teamId === fromTeamId;

  // Public URL for the header's open ↗ / copy-link quick actions (QA4 fix 3):
  // personal events need the member's handle, team events the team's slug.
  const me = await adminApi.me();
  let publicPath: string | null = null;
  if (me?.accountCode) {
    if (et.teamId) {
      const team = (await adminApi.listTeams()).find((t) => t.id === et.teamId);
      publicPath = team?.slug ? `/${me.accountCode}/team/${team.slug}/${et.slug}` : null;
    } else if (me.handle) {
      publicPath = `/${me.accountCode}/${me.handle}/${et.slug}`;
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-8 pb-10">
      <EventTypeForm
        initial={et}
        schedules={schedules}
        messages={m}
        scheduling={et.teamId ? msgs.scheduling : undefined}
        teamMembers={teamMembers}
        connections={et.teamId ? undefined : connections}
        backHref={backToTeam ? `/admin/teams/${fromTeamId}` : '/admin/event-types'}
        backLabel={backToTeam ? msgs.admin.teams.title : m.title}
        heading={et.title}
        headerExtras={
          publicPath ? (
            // Visibility stays on the form's own "Hidden" checkbox — only the
            // open/copy shortcuts live up here.
            <EventRowActions id={et.id} hidden={et.hidden} publicPath={publicPath} messages={m} hideToggle />
          ) : undefined
        }
      />
    </div>
  );
}
