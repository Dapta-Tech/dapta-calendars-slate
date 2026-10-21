import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { Select, type SelectOption } from '@/components/ui/select';

type TeamHostsMessages = BookingMessages['admin']['eventTypes']['teamHosts'];
type PriorityMessages = Pick<BookingMessages['admin']['eventTypes'], 'priority' | 'priorityLevels'>;

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
 *
 * Creating teams and team events is admin-only, so a plain member gets the
 * explanation without links that would end in a refusal.
 */
export function PersonalHostsCard({
  teams,
  title,
  canManageTeams,
  m,
}: {
  teams: TeamOption[];
  /** The Hosts block's own title, shared with team events. */
  title: string;
  /** Owner or admin: may create teams and team events. */
  canManageTeams: boolean;
  m: TeamHostsMessages;
}) {
  return (
    <div
      data-testid="personal-hosts-card"
      className="flex flex-col gap-inline rounded-md border border-border bg-background/40 p-card"
    >
      <span className="text-sm font-semibold text-muted-foreground">{title}</span>
      <p className="text-xs text-muted-foreground">{m.personalHint}</p>
      {canManageTeams ? (
        <div className="flex flex-wrap gap-inline">
          {teams.length > 0 ? (
            teams.map((team) => (
              <ActionLink
                key={team.id}
                href={`/admin/event-types/new?teamId=${team.id}`}
                label={m.newEventFor.replace('{team}', team.name)}
              />
            ))
          ) : (
            <ActionLink href="/admin/teams/new" label={m.createTeam} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A long team name truncates inside the fixed-height button rather than
 *  spilling out of it on a narrow screen; the full label stays in `title`. */
function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'max-w-full')}
    >
      <span className="truncate">{label}</span>
    </Link>
  );
}

/**
 * The TEAM event's Hosts block says where its hosts come from: every member of
 * the team hosts it, and the roster lives on the team page. The block has no
 * add or remove of its own, so without this line it read as a fixed list. The
 * link is for those who can manage the roster; a plain member reads the first
 * sentence only.
 */
export function TeamHostsNote({
  teamId,
  teamName,
  canManageTeams,
  m,
}: {
  teamId: string;
  teamName: string;
  canManageTeams: boolean;
  m: TeamHostsMessages;
}) {
  return (
    <p data-testid="team-hosts-note" className="text-xs text-muted-foreground">
      {m.everyMember.replace('{team}', teamName)}
      {canManageTeams ? (
        <>
          {' '}
          <Link
            href={`/admin/teams/${teamId}`}
            className="font-medium text-primary underline underline-offset-4"
          >
            {m.manageOnTeamPage}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/**
 * A round robin host's priority as five levels, stored as the integers the
 * host selector already ranks by (highest free host first). Medium is 0: the
 * value every host starts with, and the one a missing priority counts as, so
 * existing hosts read Medium and assignment does not change.
 */
export const PRIORITY_LEVELS = [
  { value: -2, key: 'lowest' },
  { value: -1, key: 'low' },
  { value: 0, key: 'medium' },
  { value: 1, key: 'high' },
  { value: 2, key: 'highest' },
] as const;

/**
 * One host's priority picker. The API accepts any integer, so a host can hold
 * a value outside the five levels. That value is shown as it is, as a
 * "Custom (n)" option that cannot be picked, and the form keeps sending it
 * until someone picks a level: opening and saving the event never rewrites it.
 */
export function HostPrioritySelect({
  hostName,
  value,
  onChange,
  m,
  locale,
}: {
  hostName: string;
  value: number | null;
  onChange: (priority: number) => void;
  m: PriorityMessages;
  locale?: string;
}) {
  const current = value ?? 0;
  const options: SelectOption[] = PRIORITY_LEVELS.map((level) => ({
    value: String(level.value),
    label: m.priorityLevels[level.key],
  }));
  if (!PRIORITY_LEVELS.some((level) => level.value === current)) {
    const custom = {
      value: String(current),
      label: m.priorityLevels.custom.replace('{n}', String(current)),
      disabled: true,
    };
    // In its place on the scale: above Highest, or below Lowest.
    if (current > 0) options.push(custom);
    else options.unshift(custom);
  }
  return (
    <Select
      value={String(current)}
      options={options}
      onChange={(v) => onChange(Number(v))}
      ariaLabel={`${hostName}: ${m.priority}`}
      locale={locale}
      // The column's width for the five levels; a custom value grows the
      // field rather than cutting its number off.
      className="w-auto min-w-28"
    />
  );
}
