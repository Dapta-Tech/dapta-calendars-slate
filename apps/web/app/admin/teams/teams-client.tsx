'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import type { Team } from '@/lib/admin-api';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteTeamAction } from './actions';

type TeamsMessages = BookingMessages['admin']['teams'];

const monogram = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase() || 'T';

/** Clean list row: logo/monogram + name→detail + member count + public-URL line,
 *  with obvious Manage and a confirm-gated Delete. Member editing lives on the
 *  detail page. */
export function TeamCard({
  team,
  memberCount,
  accountCode,
  messages: m,
  locale,
}: {
  team: Team;
  memberCount: number;
  accountCode: string;
  messages: TeamsMessages;
  /** Active admin locale — the ConfirmDialog's own confirm/cancel copy. */
  locale?: Locale;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog(locale);
  const publicPath = accountCode && team.slug ? `/${accountCode}/team/${team.slug}` : null;

  // Deleting a team used to swap the Delete button for two smaller buttons in
  // the same corner of the row — nothing trapped focus, nothing was announced,
  // and the question was never actually asked. Now it is asked, and it names
  // the team.
  const askDelete = async () => {
    const ok = await confirm({
      title: m.deleteTitle,
      message: t(m.deleteBody, { name: team.name }),
      confirmLabel: m.delete,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteTeamAction(team.id);
      if (!r.ok) setErr(r.message ?? m.deleteError);
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-4">
      <Link href={`/admin/teams/${team.id}`} className="flex min-w-0 items-center gap-3">
        {team.logoUrl ? (
          <img src={team.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-md border border-border object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-foreground">
            {monogram(team.name)}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium hover:text-primary">{team.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            /{team.slug} · {memberCount} {memberCount === 1 ? m.memberSingular : m.memberPlural}
          </span>
          {publicPath ? <span className="truncate text-xs text-muted-foreground">{publicPath}</span> : null}
        </span>
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href={`/admin/teams/${team.id}`}
          className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:border-primary"
        >
          {m.manage}
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={() => void askDelete()}
          aria-label={`${m.delete} · ${team.name}`}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:opacity-60"
        >
          {m.delete}
        </button>
      </div>
      {err ? <p className="w-full text-xs text-destructive">{err}</p> : null}
      {dialog}
    </div>
  );
}
