'use client';

import Link from 'next/link';
import { useActionState, useState, useTransition } from 'react';
import type { Team } from '@/lib/admin-api';
import { createTeamAction, deleteTeamAction, type ActionResult } from './actions';

const monogram = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase() || 'T';

export function NewTeamForm() {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(createTeamAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <input name="name" required className="rounded-md border border-input bg-background px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Slug</span>
        <input name="slug" required className="rounded-md border border-input bg-background px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Timezone</span>
        <input name="timeZone" defaultValue="America/New_York" className="rounded-md border border-input bg-background px-3 py-2" />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? '…' : 'Create team'}
      </button>
      {res && !res.ok ? <p className="w-full text-sm text-destructive">{res.message}</p> : null}
    </form>
  );
}

/** Clean list row: monogram + name→detail + member count, with obvious Manage
 *  and a confirm-gated Delete. Member editing lives on the detail page. */
export function TeamCard({ team, memberCount }: { team: Team; memberCount: number }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-4">
      <Link href={`/admin/teams/${team.id}`} className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-foreground">
          {monogram(team.name)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium hover:text-primary">{team.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            /{team.slug} · {memberCount} member{memberCount === 1 ? '' : 's'}
          </span>
        </span>
      </Link>
      <div className="flex items-center gap-2">
        <Link
          href={`/admin/teams/${team.id}`}
          className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:border-primary"
        >
          Manage
        </Link>
        {confirming ? (
          <span className="flex items-center gap-1 text-sm">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await deleteTeamAction(team.id);
                  if (!r.ok) setErr(r.message ?? 'Could not delete.');
                  setConfirming(false);
                })
              }
              className="rounded-md border border-destructive px-2 py-1 text-destructive disabled:opacity-60"
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-border px-2 py-1">
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
          >
            Delete
          </button>
        )}
      </div>
      {err ? <p className="w-full text-xs text-destructive">{err}</p> : null}
    </div>
  );
}
