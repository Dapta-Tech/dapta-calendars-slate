'use client';

import { useActionState, useTransition } from 'react';
import type { Team } from '@/lib/admin-api';
import {
  addMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeMemberAction,
  type ActionResult,
} from './actions';

type Member = { id: string; display_name: string | null; email: string | null };
type TeamMember = { member_id: string; role: string; display_name: string | null };

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

export function TeamCard({
  team,
  members,
  accountMembers,
}: {
  team: Team;
  members: TeamMember[];
  accountMembers: Member[];
}) {
  const [pending, start] = useTransition();
  const inTeam = new Set(members.map((m) => m.member_id));
  const addable = accountMembers.filter((m) => !inTeam.has(m.id));

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="flex flex-col">
          <span className="font-medium">{team.name}</span>
          <span className="text-sm text-muted-foreground">/{team.slug}</span>
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => confirm(`Delete team ${team.name}?`) && start(() => deleteTeamAction(team.id))}
          className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
        >
          Delete
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {members.map((m) => (
          <span key={m.member_id} className="flex items-center gap-2 rounded-sm bg-muted px-2 py-1 text-sm">
            {m.display_name ?? m.member_id.slice(0, 6)}
            <button
              type="button"
              onClick={() => start(() => removeMemberAction(team.id, m.member_id))}
              className="text-muted-foreground hover:text-destructive"
            >
              ×
            </button>
          </span>
        ))}
        {members.length === 0 ? <span className="text-sm text-muted-foreground">No members</span> : null}
      </div>
      {addable.length > 0 ? (
        <select
          onChange={(e) => e.target.value && start(() => addMemberAction(team.id, e.target.value))}
          defaultValue=""
          className="w-56 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="" disabled>
            + Add member…
          </option>
          {addable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name ?? m.email ?? m.id}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
