import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import type { WorkspaceView } from '@slate/types';
import { LANDING_ID_COOKIE, getMessages } from '@slate/shared';
import { adminApi, ApiError, isAdminRole } from '@/lib/admin-api';
import { AdminShell } from '@/components/admin-shell';
import { HostAnalytics } from '@/components/analytics/host-analytics';
import { analyticsConfig, hostAnalyticsIdentity } from '@/lib/analytics/config';
import { ToastProvider } from '@/components/toast';
import { TimeZoneSync } from '@/components/timezone-sync';
import { WorkspaceSync } from '@/components/workspace-sync';
import { chosenWorkspace } from '@/lib/workspace';
import { currentReturnTo, getSession } from '@/lib/auth-session';
import { withReturnTo } from '@/lib/return-to';
import { currentAccountId, listWorkspaces, mayPickAccount } from '@/lib/iam';
import { docsNavHref } from '@/lib/docs-url';
import { getLocale } from '@/lib/locale';
import { getProductTheme } from '@/lib/theme.server';
import { ONBOARDING_SKIP_COOKIE } from '@/lib/onboarding';
import { PublicOriginProvider } from '@/components/public-origin';
import { bookingOrigin } from '@/lib/booking-host';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();

  // The real auth gate (AUTH-WEB-CONTRACT §4): identity is whatever `/v1/me`
  // resolves. A 401 (no/invalid session — e.g. after logout in AUTH_LOCAL_STRICT
  // mode, or an expired token) → /login. This is the global guard that makes
  // logout real; a non-401 error (API down) surfaces to the error boundary.
  //
  // The page asked for travels with the redirect as the login's return target,
  // so a host who opened a booking from an email lands back on it after signing
  // in. (The client's own 401 path does the same, see `signOutKeepingPlace`.)
  let me: Awaited<ReturnType<typeof adminApi.me>>;
  try {
    me = await adminApi.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect(withReturnTo('/login', await currentReturnTo()));
    throw e;
  }

  // Onboarding's two gates (ADR 0002). The verdicts are the API's — read off
  // the /v1/me call we already made, never re-derived here from an empty
  // event-type list, which is what causes redirect loops and flicker.
  //
  // The skip cookie is what keeps this a nudge rather than a trap: #65 makes
  // the Home "Get bookable" checklist the recovery path for a host who
  // abandons the wizard, and that checklist is unreachable if the guard
  // redirects forever. Session-scoped, so the wizard returns next visit.
  const skipped = jar.get(ONBOARDING_SKIP_COOKIE)?.value === '1';
  if (!skipped && (me.onboardingRequired || me.setupRequired)) redirect('/onboarding');

  // Server-read the collapse pref so the sidebar renders at the right width on
  // first paint (no rail FOUC).
  const initialCollapsed = jar.get('slate.nav.collapsed')?.value === '1';
  // Same trick for the theme: the root layout has already stamped `data-theme`
  // from this cookie, and the toggle needs the same value so its icon and label
  // agree with the palette on the very first paint.
  //
  // `getProductTheme()` and NOT `resolveDocumentTheme()`, even though the root
  // layout uses the latter: this is an admin route, so the answer is the cookie
  // by definition, and on `resolveDocumentTheme`'s missing-header fallback the
  // root would stamp the booking canvas while `ThemeStamp` immediately corrects
  // the document back to the cookie's theme. Seeding from the cookie is what
  // keeps the toggle agreeing with where the page actually lands.
  const initialTheme = await getProductTheme();
  const locale = await getLocale();
  const messages = getMessages(locale).admin;

  // The account picker, for operator staff only — see `mayPickAccount`. Asked
  // for here rather than inside the shell because the token must not reach the
  // browser, and skipped entirely for everyone else so no customer's render
  // waits on an upstream call that would return nothing they may use.
  const session = await getSession();
  const canPick = session?.provider === 'workos' && mayPickAccount(session.accessToken);
  // Only the first page: the picker searches upstream for the rest, so this
  // render never pays for a list as long as the customer base.
  const accounts =
    canPick && session.provider === 'workos'
      ? await listWorkspaces(session.accessToken)
      : { items: [], hasMore: false };

  // The person's own workspaces (their account, the ones they joined, pending
  // invitations): the rail offers a switcher from two. A failure here costs the
  // switcher, never the page.
  let workspaces: WorkspaceView[] = [];
  try {
    workspaces = await adminApi.myWorkspaces();
  } catch (e) {
    unstable_rethrow(e);
  }
  // The staff picker marks the account the TOKEN names; while another
  // workspace is open that mark would point at the wrong row, so it marks none.
  const inHome = workspaces.length === 0 || workspaces.some((w) => w.current && w.home);

  // Product analytics, read at request time (never inlined at build): null
  // when the deployment configures none, and then nothing loads.
  const analytics = analyticsConfig();

  return (
    <ToastProvider>
      <TimeZoneSync currentTimeZone={me.timeZone} />
      <WorkspaceSync rendered={await chosenWorkspace()} />
      <HostAnalytics
        config={analytics}
        identity={analytics ? hostAnalyticsIdentity(me, jar.get(LANDING_ID_COOKIE)?.value) : null}
      />
      {/* Public booking links (copy, open, embed) name the booking host when
          booking pages have one, read here at request time. */}
      <PublicOriginProvider origin={bookingOrigin()}>
      <AdminShell
        initialCollapsed={initialCollapsed}
        initialTheme={initialTheme}
        messages={messages}
        isAdmin={isAdminRole(me.role)}
        // Runtime env, in the reader's language; null on a deployment with no
        // docs configured, and the rail then has no Docs item.
        docsHref={docsNavHref(locale)}
        user={{ displayName: me.displayName, email: me.email, handle: me.handle, accountCode: me.accountCode }}
        accounts={accounts.items}
        accountsHasMore={accounts.hasMore}
        currentAccountId={
          session?.provider === 'workos' && inHome ? currentAccountId(session.accessToken) : null
        }
        workspaces={workspaces}
      >
        {children}
      </AdminShell>
      </PublicOriginProvider>
    </ToastProvider>
  );
}
