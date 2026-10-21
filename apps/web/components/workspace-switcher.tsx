'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import type { WorkspaceView } from '@slate/types';
import { enterWorkspaceAction } from '@/app/admin/workspace-actions';
import { AnchoredMenu } from '@/components/ui/anchored-menu';

/**
 * Which of the person's workspaces the dashboard is in, and the others they can
 * open: the account they own, the ones they joined, and invitations not yet
 * opened (marked "Invited"; opening one accepts it). The dForms rail's
 * workspace card, without its estate search and "New workspace": a person here
 * has a handful of workspaces, all their own.
 *
 * Rendered only for someone with two or more; with one there is nothing to
 * switch to and the rail looks exactly as it did.
 */
export function WorkspaceSwitcher({
  workspaces,
  messages: m,
  collapsed = false,
}: {
  workspaces: WorkspaceView[];
  messages: BookingMessages['admin']['workspaces'];
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setFailed(false);
  }, []);

  if (workspaces.length < 2) return null;
  const current = workspaces.find((w) => w.current) ?? workspaces[0]!;
  const label = current.accountName;

  const choose = (w: WorkspaceView) => {
    // The current row stays focusable (a disabled button cannot take focus, and
    // the menu's keys need every row reachable), so it is inert here instead.
    if (w.current || pending) return;
    const accountId = w.accountId;
    setFailed(false);
    startTransition(async () => {
      // A successful switch redirects and never returns; only a refusal does.
      const result = await enterWorkspaceAction(accountId);
      if (result?.error) setFailed(true);
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="workspace-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${m.menuLabel}: ${label}`}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={[
          'flex min-h-control items-center gap-inline rounded-md border border-border bg-card text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]',
          collapsed ? 'mx-auto w-11 justify-center' : 'w-full px-inline',
        ].join(' ')}
      >
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-primary/15 text-xs font-semibold text-foreground"
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
            <i aria-hidden className="pi pi-chevron-down text-muted-foreground" style={{ fontSize: 10 }} />
          </>
        ) : null}
      </button>

      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        label={m.menuLabel}
        width="anchor"
        minWidth={256}
        autoFocus
        className="p-inline"
        testId="workspace-switcher-menu"
      >
        <p className="px-inline py-tight text-2xs font-semibold uppercase tracking-wide text-faint">{m.menuLabel}</p>
        <div className="max-h-64 overflow-y-auto">
          {workspaces.map((w) => (
            <button
              key={w.accountId}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={pending || w.current ? 'true' : undefined}
              aria-current={w.current ? 'true' : undefined}
              onClick={() => choose(w)}
              className={[
                'flex min-h-control w-full items-center gap-field rounded-sm px-inline py-inline text-left text-sm transition-colors',
                w.current
                  ? 'bg-muted font-medium'
                  : 'hover:bg-accent hover:text-accent-foreground aria-disabled:opacity-60',
              ].join(' ')}
            >
              <span className="min-w-0 flex-1 truncate">{w.accountName}</span>
              {w.status === 'invited' ? (
                <span className="shrink-0 rounded-sm bg-muted px-tight text-2xs font-medium text-muted-foreground">
                  {m.pending}
                </span>
              ) : null}
              {w.current ? (
                <>
                  <i aria-hidden className="pi pi-check text-primary" style={{ fontSize: 14 }} />
                  <span className="sr-only">{m.current}</span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      </AnchoredMenu>
      {/* Outside the menu: an alert is not a menu's child, and it must stay readable once the menu closes. */}
      {failed && !collapsed ? (
        <p role="alert" className="px-inline py-tight text-xs text-destructive">
          {m.switchFailed}
        </p>
      ) : null}
    </>
  );
}
