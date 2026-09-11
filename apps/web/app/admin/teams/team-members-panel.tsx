'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import { Modal } from '@/components/modal';
import { useToast } from '@/components/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { inviteMemberByEmailAction, removeMemberAction, setMemberRoleAction } from './actions';

type TeamsMessages = BookingMessages['admin']['teams'];

interface Member {
  member_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
}

const initialOf = (m: { display_name: string | null; email: string | null }) =>
  (m.display_name?.trim()?.[0] ?? m.email?.trim()?.[0] ?? '?').toUpperCase();

export function TeamMembersPanel({
  teamId,
  members,
  messages: m,
  locale,
}: {
  teamId: string;
  members: Member[];
  messages: TeamsMessages;
  /** Active admin locale — the Select's and ConfirmDialog's own copy. */
  locale?: Locale;
}) {
  const [pending, start] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'member'>('member');
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  // Whether the current error is the 'not an account member' case — it gets a CTA to the real invite flow (QA fix 7).
  const [inviteNoMatch, setInviteNoMatch] = useState(false);
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  // Two options, spelled once — the row picker and the invite picker offer the
  // same choice and must not drift apart. Memoised so `Select`'s own filter memo
  // is not invalidated on every render of this panel.
  const roleOptions = useMemo(
    () => [
      { value: 'member', label: m.roleMember },
      { value: 'owner', label: m.roleOwner },
    ],
    [m.roleMember, m.roleOwner],
  );

  const ownerCount = members.filter((mem) => mem.role === 'owner').length;

  // `Modal` owns Escape and the focus restore now; this only clears the state.
  const closeDialog = () => setAddOpen(false);

  const run = (p: Promise<{ ok: boolean; message?: string }>, ok: string) =>
    start(async () => {
      const r = await p;
      if (r.ok) success(ok);
      else error(r.message ?? m.genericError);
    });

  // Removing a member used to swap the Remove button for two smaller buttons in
  // the same list row: no focus trap, no announcement, no question. Now it is a
  // dialog and it names the person.
  const askRemove = async (member: Member) => {
    const ok = await confirm({
      title: m.removeTitle,
      message: t(m.removeBody, { name: member.display_name ?? member.email ?? m.memberPending }),
      confirmLabel: m.remove,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (!ok) return;
    run(removeMemberAction(teamId, member.member_id), m.memberRemoved);
  };

  const submitInvite = () =>
    start(async () => {
      setInviteErr(null);
      const r = await inviteMemberByEmailAction(teamId, inviteEmail, inviteRole);
      if (r.ok) {
        success(m.memberAdded);
        setInviteEmail('');
        setInviteRole('member');
        closeDialog();
        return;
      }
      // Localize the stable code; pass a BE 409 message through verbatim.
      setInviteNoMatch(r.code === 'NO_MATCH');
      setInviteErr(
        r.code === 'INVALID_EMAIL'
          ? m.emailInvalid
          : r.code === 'NO_MATCH'
            ? m.noAccountMember
            : (r.message ?? m.genericError),
      );
    });

  return (
    <div className="flex flex-col gap-card rounded-xl border border-border bg-card p-card sm:p-card">
      <div className="flex flex-wrap items-center justify-between gap-field">
        <span className="text-sm font-semibold text-muted-foreground">{m.members}</span>
        <Button
          size="lg"
          onClick={() => {
            setInviteErr(null);
            setAddOpen(true);
          }}
        >
          {m.addMember}
        </Button>
      </div>

      {members.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-card text-sm text-muted-foreground">
          {m.noMembers}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {members.map((member) => {
            const isOwner = member.role === 'owner';
            const isLastOwner = isOwner && ownerCount === 1;
            return (
              // Identity on its own line at 360px; the pill, the picker and the
              // remove control below it, rather than seven things wrapping through
              // a 328px row.
              <li
                key={member.member_id}
                className="flex flex-col gap-field py-field sm:flex-row sm:flex-wrap sm:items-center"
              >
                <span className="flex min-w-0 flex-1 items-center gap-field">
                  {/* Member avatar — an initials monogram (members carry no image URL). */}
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground"
                  >
                    {initialOf(member)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{member.display_name ?? member.member_id.slice(0, 8)}</span>
                    {/* Email line (or a Pending label when the member hasn't a resolved email). */}
                    <span className="truncate text-xs text-muted-foreground">{member.email ?? m.memberPending}</span>
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-inline">
                {/* Role pill (owner = accent) with an inline change select; the last
                    owner's role is locked so the team can't be left ownerless. */}
                <span
                  className={`rounded-sm px-inline py-tight text-xs font-medium ${
                    isOwner ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isOwner ? m.roleOwner : m.roleMember}
                </span>
                <div className="w-36 shrink-0">
                  <Select
                    value={isOwner ? 'owner' : 'member'}
                    options={roleOptions}
                    disabled={pending || isLastOwner}
                    title={isLastOwner ? m.lastOwnerTitle : undefined}
                    ariaLabel={m.role}
                    locale={locale}
                    onChange={(v) =>
                      run(setMemberRoleAction(teamId, member.member_id, v as 'owner' | 'member'), m.roleUpdated)
                    }
                  />
                </div>
                {/* Owner-lock: owners show a lock (no remove affordance); demote to
                    member first to remove. Members get the ConfirmDialog. */}
                {isOwner ? (
                  <span className="flex items-center gap-tight text-xs text-muted-foreground" title={m.ownerLock}>
                    <i aria-hidden className="pi pi-lock" style={{ fontSize: 13 }} />
                    <span className="sr-only">{m.ownerLock}</span>
                  </span>
                ) : (
                  <Button
                    variant="destructive"
                    size="lg"
                    disabled={pending}
                    onClick={() => void askRemove(member)}
                    aria-label={`${m.remove} · ${member.display_name ?? member.email ?? ''}`}
                  >
                    {m.remove}
                  </Button>
                )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Invite-by-email dialog (old-app parity): email + role chosen at add time.
          Was a hand-rolled `fixed inset-0` stack; `Modal` owns the focus trap,
          the scroll lock, Escape and the focus restore. */}
      <Modal open={addOpen} onClose={closeDialog} title={m.inviteTitle} labelId="invite-dialog-title">
        <p className="mb-card text-sm text-muted-foreground">{m.inviteLead}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitInvite();
          }}
          className="flex flex-col gap-field"
        >
          <label className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.emailLabel}</span>
            <Input
              type="email"
              value={inviteEmail}
              placeholder={m.emailPlaceholder}
              data-modal-autofocus
              className="min-h-control"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </label>
          {/* A <div>, not a <label>: the Select's trigger is a <button>, which
              is not a labelable element. The name rides on `ariaLabel`. */}
          <div className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.role}</span>
            <Select
              value={inviteRole}
              options={roleOptions}
              ariaLabel={m.role}
              locale={locale}
              onChange={(v) => setInviteRole(v as 'owner' | 'member')}
            />
          </div>
          {inviteErr ? (
            <div role="alert" className="flex flex-col items-start gap-tight">
              <p className="text-sm text-destructive">{inviteErr}</p>
              {/* The recovery path out of "that email is not on your account".
                  It was an underlined link with an arrow stapled to it, inside
                  the error sentence; it is now a control of its own, below the
                  message, where a control belongs. */}
              {inviteNoMatch ? (
                <Link
                  href="/admin/settings/members"
                  className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), '-ml-field')}
                >
                  <i aria-hidden className="pi pi-users" style={{ fontSize: 13 }} />
                  {m.inviteFromMembers}
                </Link>
              ) : null}
            </div>
          ) : null}
          <div className="mt-tight flex flex-wrap justify-end gap-inline">
            <Button variant="outline" size="lg" onClick={closeDialog}>
              {m.cancel}
            </Button>
            <Button type="submit" size="lg" disabled={pending || !inviteEmail}>
              {m.sendInvite}
            </Button>
          </div>
        </form>
      </Modal>
      {dialog}
    </div>
  );
}
