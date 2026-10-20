import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { buttonVariants } from '@/components/ui/button';

type TeamHostsMessages = BookingMessages['admin']['eventTypes']['teamHosts'];

export interface TeamOption {
  id: string;
  name: string;
}

/**
 * The PERSONAL event's answer to "where do I add my team?". A personal event
 * has no hosts to add and cannot become a team event, so the honest answer is
 * a pointer: one link per team to start a team event there, or to create the
 * first team. Sits in the slot where a team event shows its Hosts block, under
 * the same title, so a person scanning for hosts finds it in either editor.
 */
export function PersonalHostsCard({
  teams,
  title,
  m,
}: {
  teams: TeamOption[];
  /** The Hosts block's own title, shared with team events. */
  title: string;
  m: TeamHostsMessages;
}) {
  return (
    <div
      data-testid="personal-hosts-card"
      className="flex flex-col gap-inline rounded-md border border-border bg-background/40 p-card"
    >
      <span className="text-sm font-semibold text-muted-foreground">{title}</span>
      <p className="text-xs text-muted-foreground">{m.personalHint}</p>
      <div className="flex flex-wrap gap-inline">
        {teams.length > 0 ? (
          teams.map((team) => (
            <Link
              key={team.id}
              href={`/admin/event-types/new?teamId=${team.id}`}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.newEventFor.replace('{team}', team.name)}
            </Link>
          ))
        ) : (
          <Link
            href="/admin/teams/new"
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            {m.createTeam}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * The TEAM event's Hosts block says where its hosts come from: every member of
 * the team hosts it, and the roster lives on the team page. The block has no
 * add or remove of its own, so without this line it read as a fixed list.
 */
export function TeamHostsNote({
  teamId,
  teamName,
  m,
}: {
  teamId: string;
  teamName: string;
  m: TeamHostsMessages;
}) {
  return (
    <p data-testid="team-hosts-note" className="text-xs text-muted-foreground">
      {m.everyMember.replace('{team}', teamName)}{' '}
      <Link
        href={`/admin/teams/${teamId}`}
        className="font-medium text-primary underline underline-offset-4"
      >
        {m.manageOnTeamPage}
      </Link>
    </p>
  );
}
