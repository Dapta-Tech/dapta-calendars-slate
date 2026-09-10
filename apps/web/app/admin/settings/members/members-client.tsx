'use client';

import { useRef, useState, useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import type { AccountMember, AccountRole, MemberStatus } from '@/lib/admin-api';
import { Modal } from '@/components/modal';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  inviteMemberAction,
  removeMemberAction,
  setMemberRoleAction,
  setMemberStatusAction,
  transferOwnershipAction,
} from './actions';

type Messages = BookingMessages['admin']['members'];

const initialOf = (m: AccountMember) =>
  (m.displayName?.trim()?.[0] ?? m.email?.trim()?.[0] ?? '?').toUpperCase();

const roleLabel = (m: Messages, role: AccountRole) =>
  role === 'owner' ? m.roleOwner : role === 'admin' ? m.roleAdmin : m.roleMember;

const statusLabel = (m: Messages, s: MemberStatus) =>
  s === 'invited' ? m.statusInvited : s === 'disabled' ? m.statusDisabled : m.statusActive;

/** Who this row is, for a dialog message and an accessible name. */
const nameOf = (member: AccountMember) =>
  member.displayName ?? member.email ?? member.id.slice(0, 8);

export function MembersClient({
  members,
  callerId,
  callerRole,
  messages: m,
  locale,
}: {
  members: AccountMember[];
  callerId: string;
  callerRole: AccountRole;
  messages: Messages;
  /** Active admin locale — the Select's and ConfirmDialog's own copy. */
  locale?: Locale;
}) {
  const [pending, start] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const isOwnerCaller = callerRole === 'owner';
  const activeOwners = members.filter((x) => x.role === 'owner' && x.status === 'active').length;

  const roleOptions = [
    { value: 'member', label: m.roleMember },
    { value: 'admin', label: m.roleAdmin },
  ];

  const run = (p: Promise<{ ok: boolean; message?: string }>, ok: string) =>
    start(async () => {
      const r = await p;
      if (r.ok) success(ok);
      else error(r.message ?? m.genericError);
    });

  // A2 (#112): both of these used to swap the trigger for two smaller buttons in
  // the same corner of the row — nothing trapped focus, nothing was announced,
  // and the question was never actually asked. Now it is asked, and it names the
  // person it is about.
  const askRemove = async (member: AccountMember) => {
    const ok = await confirm({
      title: m.removeTitle,
      message: t(m.removeBody, { name: nameOf(member) }),
      confirmLabel: m.remove,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (ok) run(removeMemberAction(member.id), m.memberRemoved);
  };

  const askTransfer = async (member: AccountMember) => {
    const ok = await confirm({
      title: m.transferTitle,
      message: t(m.transferBody, { name: nameOf(member) }),
      confirmLabel: m.transferConfirm,
      cancelLabel: m.cancel,
    });
    if (ok) run(transferOwnershipAction(member.id), m.ownershipTransferred);
  };

  const closeDialog = () => {
    setAddOpen(false);
    triggerRef.current?.focus();
  };

  const submitInvite = () =>
    start(async () => {
      setInviteErr(null);
      const r = await inviteMemberAction(inviteEmail, inviteRole);
      if (r.ok) {
        success(m.memberInvited);
        setInviteEmail('');
        setInviteRole('member');
        closeDialog();
        return;
      }
      setInviteErr(
        r.code === 'INVALID_EMAIL'
          ? m.emailInvalid
          : r.code === 'EMAIL_TAKEN'
            ? m.emailTaken
            : (r.message ?? m.genericError),
      );
    });

  return (
    <div className="flex flex-col gap-4">
      {/* List/create pattern: the roster with the primary action top-right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-semibold text-muted-foreground">{m.rosterLabel}</span>
        <Button
          ref={triggerRef}
          size="lg"
          onClick={() => {
            setInviteErr(null);
            setAddOpen(true);
          }}
        >
          {m.invite}
        </Button>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
        {members.map((member) => {
          const isSelf = member.id === callerId;
          const isOwner = member.role === 'owner';
          // Last-owner lock applies to the last ACTIVE owner only — an invited
          // owner isn't in activeOwners, so locking it made an accidental
          // promotion permanent (QA2 fix 6a).
          const isLastOwner = isOwner && member.status === 'active' && activeOwners <= 1;
          // Admins may not act on owners; only an owner can. Never act on yourself
          // here (you can't lock yourself out of your own workspace).
          const canManage = !isSelf && (isOwnerCaller || !isOwner);
          const lockRole = !canManage || isLastOwner;
          // Owners are removed by demoting first (mirrors the team owner-lock).
          const canRemove = canManage && !isOwner;
          const canToggleStatus = canManage && !isOwner;
          // Single-owner model (QA2 fix 6b): ownership moves only via this
          // explicit action — owner-only, to an active non-owner member.
          const canTransfer = isOwnerCaller && !isSelf && !isOwner && member.status === 'active';
          const label = nameOf(member);
          // The dropdown can DEMOTE an owner (legacy multi-owner states) but
          // never mint one — promotion is the transfer flow only.
          const options = isOwner ? [...roleOptions, { value: 'owner', label: m.roleOwner }] : roleOptions;

          return (
            // Two rows at 360px — identity above, controls below — instead of one
            // wrapping line that put an avatar, two pills, a picker and three
            // buttons through the same 328px.
            <li key={member.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:px-5">
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background bg-cover bg-center text-xs font-semibold text-muted-foreground"
                  style={member.avatarUrl ? { backgroundImage: `url(${JSON.stringify(member.avatarUrl)})` } : undefined}
                >
                  {member.avatarUrl ? '' : initialOf(member)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 truncate text-sm font-medium">
                    {label}
                    {isSelf ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {m.you}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {member.email ?? m.noEmail}
                  </span>
                </span>
              </span>

              <span className="flex flex-wrap items-center gap-2">
                {/* Status pill (invited / disabled stand out; active is quiet). */}
                <span
                  className={`rounded-sm px-2 py-0.5 text-xs font-medium ${
                    member.status === 'invited'
                      ? 'bg-primary/10 text-primary'
                      : member.status === 'disabled'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {statusLabel(m, member.status)}
                </span>

                {/* Role pill + inline change picker (owner-only options gated).
                    The picker is P's Select, not a native <select>: the OS popup
                    it used to open is drawn in the user agent's own colours and
                    is the one piece of another design language left on a themed
                    page. `title` is why the primitive has one — a locked picker
                    has to be able to say WHY. */}
                <span
                  className={`rounded-sm px-2 py-0.5 text-xs font-medium ${
                    isOwner ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {roleLabel(m, member.role)}
                </span>
                <Select
                  value={member.role}
                  options={options}
                  disabled={pending || lockRole}
                  title={isLastOwner ? m.lastOwnerTitle : undefined}
                  ariaLabel={`${m.roleLabel} · ${label}`}
                  locale={locale}
                  className="w-36"
                  onChange={(v) => run(setMemberRoleAction(member.id, v as AccountRole), m.roleUpdated)}
                />

                {canTransfer ? (
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={pending}
                    aria-label={`${m.transferOwnership} · ${label}`}
                    onClick={() => void askTransfer(member)}
                  >
                    {m.transferOwnership}
                  </Button>
                ) : null}

                {/* Enable / disable (soft access revocation). */}
                {canToggleStatus ? (
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={pending}
                    aria-label={`${member.status === 'disabled' ? m.enable : m.disable} · ${label}`}
                    onClick={() =>
                      run(
                        setMemberStatusAction(member.id, member.status === 'disabled' ? 'active' : 'disabled'),
                        m.statusUpdated,
                      )
                    }
                  >
                    {member.status === 'disabled' ? m.enable : m.disable}
                  </Button>
                ) : null}

                {/* Remove — owners show a lock (demote first); everyone else asks. */}
                {isOwner ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" title={m.ownerLock}>
                    <i aria-hidden className="pi pi-lock" style={{ fontSize: 13 }} />
                    <span className="sr-only">{m.ownerLock}</span>
                  </span>
                ) : canRemove ? (
                  <Button
                    variant="destructive"
                    size="lg"
                    disabled={pending}
                    aria-label={`${m.remove} · ${label}`}
                    onClick={() => void askRemove(member)}
                  >
                    {m.remove}
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Invite-by-email dialog. Was a hand-rolled `fixed inset-0` stack with no
          focus trap and no scroll lock, beside a Modal that has both. */}
      <Modal open={addOpen} onClose={closeDialog} title={m.inviteTitle} labelId="invite-member-title">
        <p className="mb-4 text-sm text-muted-foreground">{m.inviteLead}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitInvite();
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.emailLabel}</span>
            <Input
              type="email"
              value={inviteEmail}
              placeholder={m.emailPlaceholder}
              data-modal-autofocus
              className="min-h-[44px]"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </label>
          {/* A <div>, not a <label>: the Select's trigger is a <button>, which is
              not a labelable element. The name rides on `ariaLabel`. */}
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.roleLabel}</span>
            <Select
              value={inviteRole}
              options={roleOptions}
              ariaLabel={m.roleLabel}
              locale={locale}
              onChange={(v) => setInviteRole(v as 'admin' | 'member')}
            />
          </div>
          {inviteErr ? <p role="alert" className="text-sm text-destructive">{inviteErr}</p> : null}
          <div className="mt-1 flex flex-wrap justify-end gap-2">
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
