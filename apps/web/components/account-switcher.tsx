'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { switchAccountAction } from '@/app/admin/account-actions';

/**
 * Account picker for the platform operator's own staff — the same move as the
 * platform app's workspace switcher, so someone sent in to set up a customer
 * lands in that customer's calendars instead of their own.
 *
 * Rendered only when the layout found accounts to offer, which it only looks
 * for on an operator login. Everyone else never sees it, and a customer has one
 * account and nothing to pick.
 *
 * One entry per workspace, deliberately not per account: this product's tenant
 * is the ACCOUNT, so a client with several workspaces has one set of calendars
 * and several rows that reach it. Listing the workspace names is what lets an
 * implementer find the client by the name they were given; the rows that share
 * an account simply all read as current once you are in it.
 *
 * WAI-ARIA menu-button pattern, same as the app switcher: Escape and
 * outside-click dismiss, focus moves to the first item on open.
 */

export interface AccountOption {
  id: string;
  accountId: string;
  name: string;
}

export function AccountSwitcher({
  accounts,
  currentAccountId,
  collapsed = false,
}: {
  accounts: AccountOption[];
  currentAccountId: string | null;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  if (accounts.length === 0) return null;

  const current = accounts.find((a) => a.accountId === currentAccountId);
  const label = current?.name ?? 'Switch account';

  const choose = (accountId: string) => {
    setError(null);
    startTransition(async () => {
      // A successful switch redirects and never returns; only a refusal does.
      const result = await switchAccountAction(accountId);
      if (result?.error) setError(result.error);
      else setOpen(false);
    });
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${label}`}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={[
          'flex items-center gap-inline rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]',
          collapsed ? 'h-11 w-11 justify-center' : 'min-h-control w-full px-inline py-inline',
        ].join(' ')}
      >
        <i aria-hidden className="pi pi-building" style={{ fontSize: 16 }} />
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-sm">{label}</span>
            <i aria-hidden className="pi pi-angle-down" style={{ fontSize: 13 }} />
          </>
        ) : null}
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Switch account"
          // Opens upward: this lives in the sidebar footer, where a downward
          // menu would render off the bottom of the viewport.
          className="absolute bottom-full left-0 z-50 mb-inline max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-popover p-inline text-popover-foreground shadow-lg"
        >
          {accounts.map((account) => {
            const active = account.accountId === currentAccountId;
            return (
              <button
                key={account.id}
                role="menuitem"
                tabIndex={-1}
                type="button"
                disabled={pending || active}
                onClick={() => choose(account.accountId)}
                className={[
                  'flex w-full items-center gap-field rounded-sm px-inline py-inline text-left text-sm transition-colors',
                  active
                    ? 'bg-muted font-medium'
                    : 'hover:bg-accent hover:text-accent-foreground disabled:opacity-60',
                ].join(' ')}
                aria-current={active ? 'true' : undefined}
              >
                <span className="min-w-0 flex-1 truncate">{account.name}</span>
                {active ? (
                  <i aria-hidden className="pi pi-check text-primary" style={{ fontSize: 14 }} />
                ) : null}
              </button>
            );
          })}

          {error ? (
            <p role="alert" className="px-inline py-tight text-xs text-destructive">
              {error === 'denied'
                ? 'You do not have access to that account.'
                : 'Could not switch account. Try again.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
