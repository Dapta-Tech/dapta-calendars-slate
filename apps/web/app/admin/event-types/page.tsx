import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { PageHeader } from '@/components/ui/page-header';
import { DeleteButton } from './delete-button';
import { EventRowActions } from './event-row-actions';

export const dynamic = 'force-dynamic';

export default async function EventTypesPage() {
  const [eventTypes, me, teams] = await Promise.all([
    adminApi.listEventTypes(),
    adminApi.me(),
    adminApi.listTeams(),
  ]);
  // Team events surface on this page too (QA3 fix 4a) — grouped per team,
  // loaded in parallel. Teams without events render nothing here (their empty
  // state lives on the team detail page).
  const teamEventGroups = (
    await Promise.all(
      teams.map(async (team) => ({ team, eventTypes: await adminApi.teamEventTypes(team.id) })),
    )
  ).filter((g) => g.eventTypes.length > 0);
  const msgs = getMessages(await getLocale());
  const admin = msgs.admin;
  const m = admin.eventTypes;

  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      {/* One CTA per screen: the top-right Create shows ONLY when the list has
          rows. On the empty state the centered CTA below is the sole create
          affordance (never both at once). */}
      <PageHeader
        title={m.title}
        action={
          eventTypes.length > 0 ? (
            <Link
              href="/admin/event-types/new"
              className="inline-flex min-h-control items-center rounded-md bg-primary px-card py-field text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
            >
              {m.newEventType}
            </Link>
          ) : undefined
        }
      />

      <ul className="flex flex-col gap-inline">
        {eventTypes.map((et) => (
          <li
            key={et.id}
            className="flex items-center justify-between gap-field rounded-md border border-border bg-card p-card"
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">
                {et.title}
                {et.hidden ? <span className="ml-inline text-xs text-muted-foreground">({m.hidden})</span> : null}
              </span>
              <span className="text-sm text-muted-foreground">
                /{et.slug} · {et.lengthMinutes} {m.minSuffix}
                {et.requiresConfirmation ? ` · ${m.needsConfirmation}` : ''}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-inline">
              <EventRowActions
                id={et.id}
                hidden={et.hidden}
                publicPath={me.handle ? `/${me.accountCode}/${me.handle}/${et.slug}` : null}
                title={et.title}
                messages={m}
                embedMessages={msgs.embed}
              />
              <Link
                href={`/admin/event-types/${et.id}`}
                className="rounded-md border border-border px-field py-tight text-sm hover:border-primary"
              >
                {admin.common.edit}
              </Link>
              <DeleteButton id={et.id} />
            </div>
          </li>
        ))}
      </ul>
      {eventTypes.length === 0 ? (
        <div className="flex flex-col items-center gap-field rounded-md border border-dashed border-border p-section text-center">
          <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
            <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z" />
            <path d="M14 6v12" strokeDasharray="2 2" />
          </svg>
          <p className="max-w-sm text-sm text-muted-foreground">{m.emptyList}</p>
          <Link
            href="/admin/event-types/new"
            className="inline-flex min-h-control items-center rounded-md bg-primary px-card py-field text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {m.newEventType}
          </Link>
        </div>
      ) : null}

      {/* Team events (QA3 fix 4a): grouped per team below the personal list.
          Back navigation is contextual to the ORIGIN (QA3 fix 4b): links here
          carry no ?from, so the editor returns to THIS page — only the team
          page's own links inject from=team. */}
      {teamEventGroups.length > 0 ? (
        <div className="mt-section">
          <h2 className="mb-field text-sm font-semibold text-muted-foreground">{m.teamEventsSection}</h2>
          <div className="flex flex-col gap-group">
            {teamEventGroups.map(({ team, eventTypes: teamEventTypes }) => (
              <section key={team.id}>
                <h3 className="mb-inline text-sm font-medium">{team.name}</h3>
                <ul className="flex flex-col gap-inline">
                  {teamEventTypes.map((et) => (
                    <li
                      key={et.id}
                      className="flex items-center justify-between gap-field rounded-md border border-border bg-card p-card"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {et.title}
                          {et.hidden ? <span className="ml-inline text-xs text-muted-foreground">({m.hidden})</span> : null}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          /{et.slug} · {et.lengthMinutes} {m.minSuffix}
                          {et.requiresConfirmation ? ` · ${m.needsConfirmation}` : ''}
                        </span>
                      </span>
                      <div className="flex shrink-0 items-center gap-inline">
                        <EventRowActions
                          id={et.id}
                          hidden={et.hidden}
                          publicPath={
                            team.slug ? `/${me.accountCode}/team/${team.slug}/${et.slug}` : null
                          }
                          title={et.title}
                          messages={m}
                          embedMessages={msgs.embed}
                        />
                        <Link
                          href={`/admin/event-types/${et.id}`}
                          className="rounded-md border border-border px-field py-tight text-sm hover:border-primary"
                        >
                          {admin.common.edit}
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
