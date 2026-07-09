'use client';

import { useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import { addMemberAction, removeMemberAction, setMemberRoleAction } from './actions';

interface Member {
  member_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
}
interface AccountMember {
  id: string;
  display_name: string | null;
  email: string | null;
}

const initialOf = (m: { display_name: string | null; email: string | null }) =>
  (m.display_name?.trim()?.[0] ?? m.email?.trim()?.[0] ?? '?').toUpperCase();

export function TeamMembersPanel({
  teamId,
  members,
  accountMembers,
}: {
  teamId: string;
  members: Member[];
  accountMembers: AccountMember[];
}) {
  const [pending, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [addId, setAddId] = useState('');
  const [addRole, setAddRole] = useState<'owner' | 'member'>('member');
  const { success, error } = useToast();

  const inTeam = new Set(members.map((m) => m.member_id));
  const addable = accountMembers.filter((m) => !inTeam.has(m.id));
  const ownerCount = members.filter((m) => m.role === 'owner').length;

  const run = (p: Promise<{ ok: boolean; message?: string }>, ok: string) =>
    start(async () => {
      const r = await p;
      if (r.ok) {
        success(ok);
        setConfirmRemove(null);
      } else {
        error(r.message ?? 'Something went wrong.');
      }
    });

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      {members.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No members yet. Add someone from your account below.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {members.map((m) => {
            const isLastOwner = m.role === 'owner' && ownerCount === 1;
            return (
              <li key={m.member_id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground">
                  {initialOf(m)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{m.display_name ?? m.member_id.slice(0, 8)}</span>
                  {m.email ? <span className="truncate text-xs text-muted-foreground">{m.email}</span> : null}
                </span>
                <select
                  value={m.role === 'owner' ? 'owner' : 'member'}
                  disabled={pending || isLastOwner}
                  title={isLastOwner ? 'A team must keep at least one owner' : undefined}
                  onChange={(e) => run(setMemberRoleAction(teamId, m.member_id, e.target.value as 'owner' | 'member'), 'Role updated.')}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm disabled:opacity-60"
                >
                  <option value="owner">Owner</option>
                  <option value="member">Member</option>
                </select>
                {confirmRemove === m.member_id ? (
                  <span className="flex items-center gap-1 text-sm">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(removeMemberAction(teamId, m.member_id), 'Member removed.')}
                      className="rounded-md border border-destructive px-2 py-1 text-destructive disabled:opacity-60"
                    >
                      Remove
                    </button>
                    <button type="button" onClick={() => setConfirmRemove(null)} className="rounded-md border border-border px-2 py-1">
                      Cancel
                    </button>
                  </span>
                ) : isLastOwner ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" title="A team must keep at least one owner">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                      <rect x="5" y="11" width="14" height="9" rx="2" />
                      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                    </svg>
                    Last owner
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirmRemove(m.member_id)}
                    className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:opacity-60"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add a member (role chosen at add time) */}
      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
        {addable.length > 0 ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Add member</span>
              <select
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
                className="w-56 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Choose someone…</option>
                {addable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name ?? m.email ?? m.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Role</span>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as 'owner' | 'member')}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <button
              type="button"
              disabled={pending || !addId}
              onClick={() => {
                run(addMemberAction(teamId, addId, addRole), 'Member added.');
                setAddId('');
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              Add
            </button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">All account members are on this team.</span>
        )}
      </div>

    </div>
  );
}
