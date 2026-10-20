'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { searchAccountsAction, switchAccountAction } from '@/app/admin/account-actions';
import { AnchoredMenu } from '@/components/ui/anchored-menu';

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
 * SEARCH IS THE PRIMARY WAY THROUGH IT. An operator login can reach every
 * account on the platform, so the list is as long as the customer base: the
 * page it opens with is a starting point, not the catalogue, and the query goes
 * upstream rather than filtering what is already here — there would be nothing
 * to filter.
 *
 * A dialog and not a `menu`: WAI-ARIA menus may not contain a textbox, and this
 * one's first control is the search field. Escape and outside-click dismiss,
 * and focus opens on the field.
 */

export interface AccountOption {
  id: string;
  accountId: string;
  name: string;
}

/** How long a pause in typing counts as "done typing", in ms. */
const SEARCH_DEBOUNCE_MS = 300;

export function AccountSwitcher({
  accounts,
  currentAccountId,
  hasMore: initialHasMore = false,
  fallbackLabel,
  collapsed = false,
}: {
  accounts: AccountOption[];
  currentAccountId: string | null;
  hasMore?: boolean;
  fallbackLabel?: string;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(accounts);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Which query the rows on screen belong to. A ref and not state: it is
  // bookkeeping for the fetch, and re-rendering on it would be noise.
  const shownQuery = useRef('');

  // The panel is placed (and shown) in a layout effect, so by the next frame
  // it is visible and the search box can take focus.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Search upstream once typing settles. The guard is what keeps opening the
  // menu free: the first page is already here from the server, and an unchanged
  // query never costs a request.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q === shownQuery.current) return;

    const timer = setTimeout(() => {
      startTransition(async () => {
        const next = await searchAccountsAction(q, 1);
        shownQuery.current = q;
        setResults(next.items);
        setHasMore(next.hasMore);
        setPage(1);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, query]);

  const loadMore = () => {
    startTransition(async () => {
      const nextPage = page + 1;
      const next = await searchAccountsAction(query.trim(), nextPage);
      setResults((curr) => [...curr, ...next.items]);
      setHasMore(next.hasMore);
      setPage(nextPage);
    });
  };

  if (accounts.length === 0) return null;

  // The current account is only named when it happens to be on screen — the
  // first page is 20 rows out of however many exist. Its code is what the
  // address bar shows, so it is the honest fallback, and it changes with the
  // account rather than reading the same in all of them.
  const current = results.find((a) => a.accountId === currentAccountId);
  const label = current?.name ?? fallbackLabel ?? 'Switch account';

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
    <>
      {/* The dForms rail's workspace card: under the wordmark, the account every
          link below belongs to, its initial in a chip. 44px tall (R28). */}
      <button
        ref={triggerRef}
        type="button"
        data-testid="account-switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account: ${label}`}
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

      {/* Portalled out of the rail (it scrolls and would clip a panel), and
          opening downward now that the card sits at the top of the rail. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        role="dialog"
        label="Switch account"
        width="anchor"
        minWidth={256}
        className="p-inline"
        testId="account-switcher-menu"
      >
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search accounts"
          aria-label="Search accounts"
          autoComplete="off"
          className="mb-inline w-full rounded-sm border border-input bg-background px-inline py-tight text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        <div className="max-h-64 overflow-y-auto">
          {results.map((account) => {
            const active = account.accountId === currentAccountId;
            return (
              <button
                key={account.id}
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

          {results.length === 0 && !pending ? (
            <p className="px-inline py-tight text-xs text-muted-foreground">
              No account matches that.
            </p>
          ) : null}

          {hasMore ? (
            <button
              type="button"
              disabled={pending}
              onClick={loadMore}
              className="w-full rounded-sm px-inline py-inline text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            >
              {pending ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>

        {/* Announced because the search runs on a timer, not on submit: with
            nothing to read, a screen reader never learns the list changed. */}
        <p aria-live="polite" className="sr-only">
          {pending ? 'Searching accounts' : `${results.length} accounts listed`}
        </p>

        {error ? (
          <p role="alert" className="px-inline py-tight text-xs text-destructive">
            {error === 'denied'
              ? 'You do not have access to that account.'
              : 'Could not switch account. Try again.'}
          </p>
        ) : null}
      </AnchoredMenu>
    </>
  );
}
