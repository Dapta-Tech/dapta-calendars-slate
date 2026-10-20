'use client';

import { useCallback, useRef, useState } from 'react';
import { signOutAction } from '@/app/login/actions';
import { resetAnalytics } from '@/lib/analytics/port';
import { AnchoredMenu } from '@/components/ui/anchored-menu';

export interface ProfileUser {
  displayName: string | null;
  email: string | null;
  handle: string | null;
  accountCode: string;
}

/**
 * The person at the foot of the rail, the way the dForms rail shows them: the
 * initial, the name, the email under it, and a chevron. It opens the account's
 * own actions, which used to be loose icons beside the name: the public page
 * (new tab) and Sign out. One row for the identity and one menu for what it can
 * do, so the name gets the full rail width instead of sharing it with targets.
 *
 * The menu is an `AnchoredMenu` (portalled: the rail scrolls and would clip
 * it), as wide as the button in the wide rail, with a readable floor on the
 * collapsed one, where the button is the 44px avatar alone.
 */
export function ProfileMenu({
  user,
  collapsed,
  messages: m,
  onNavigate,
}: {
  user: ProfileUser | null;
  collapsed: boolean;
  messages: { label: string; viewPublic: string; signOut: string; opensNewTab: string };
  /** Closes the mobile drawer when an item takes the person elsewhere. */
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const displayName = user?.displayName?.trim() || null;
  const email = user?.email?.trim() || null;
  const primary = displayName ?? email ?? '';
  const secondary = displayName ? email : null;
  const initial = (primary.charAt(0) || 'A').toUpperCase();
  const accessibleName = primary ? `${primary}. ${m.label}` : m.label;

  const itemClass =
    'flex min-h-control w-full items-center gap-inline px-field text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        data-testid="profile-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={accessibleName}
        title={collapsed ? primary : undefined}
        className={`flex items-center gap-inline rounded-md text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] ${
          collapsed ? 'mx-auto h-11 w-11 justify-center' : 'min-h-control w-full px-inline py-tight'
        }`}
      >
        <span
          aria-hidden
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground"
        >
          {initial}
        </span>
        {!collapsed ? (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground" title={primary}>
                {primary}
              </span>
              {secondary ? (
                <span className="truncate text-xs text-muted-foreground" title={secondary}>
                  {secondary}
                </span>
              ) : null}
            </span>
            <i
              aria-hidden
              className={`pi ${open ? 'pi-chevron-up' : 'pi-chevron-down'} shrink-0 text-muted-foreground`}
              style={{ fontSize: 10 }}
            />
          </>
        ) : null}
      </button>

      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        label={m.label}
        width="anchor"
        minWidth={200}
        autoFocus
        className="flex flex-col overflow-hidden py-tight"
        testId="profile-menu"
      >
        {user?.handle ? (
          <a
            href={`/${user.accountCode}/${user.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            data-testid="profile-view-public"
            onClick={() => {
              close();
              onNavigate?.();
            }}
            className={itemClass}
          >
            <i aria-hidden className="pi pi-globe text-muted-foreground" style={{ fontSize: 14 }} />
            <span className="min-w-0 flex-1 truncate">{m.viewPublic}</span>
            <i aria-hidden className="pi pi-external-link text-muted-foreground" style={{ fontSize: 13 }} />
            <span className="sr-only"> {m.opensNewTab}</span>
          </a>
        ) : null}
        {user?.handle ? <div className="my-tight border-t border-border" role="separator" /> : null}
        {/* Sign-out: a server action clears the session cookie. The analytics
            identity goes with the session: the next person to use this browser
            must not be filed as this host. */}
        <form action={signOutAction}>
          <button
            type="submit"
            role="menuitem"
            data-testid="profile-sign-out"
            onClick={() => resetAnalytics()}
            className={itemClass}
          >
            <i aria-hidden className="pi pi-sign-out text-muted-foreground" style={{ fontSize: 14 }} />
            <span className="min-w-0 flex-1 truncate">{m.signOut}</span>
          </button>
        </form>
      </AnchoredMenu>
    </>
  );
}
