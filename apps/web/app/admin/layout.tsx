import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi, ApiError } from '@/lib/admin-api';
import { AdminShell } from '@/components/admin-shell';
import { ToastProvider } from '@/components/toast';
import { TimeZoneSync } from '@/components/timezone-sync';
import { getLocale } from '@/lib/locale';
import { getProductTheme } from '@/lib/theme.server';
import { ONBOARDING_SKIP_COOKIE } from '@/lib/onboarding';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();

  // The real auth gate (AUTH-WEB-CONTRACT §4): identity is whatever `/v1/me`
  // resolves. A 401 (no/invalid session — e.g. after logout in AUTH_LOCAL_STRICT
  // mode, or an expired token) → /login. This is the global guard that makes
  // logout real; a non-401 error (API down) surfaces to the error boundary.
  let me: Awaited<ReturnType<typeof adminApi.me>>;
  try {
    me = await adminApi.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login');
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
  const messages = getMessages(await getLocale()).admin;

  return (
    <ToastProvider>
      <TimeZoneSync currentTimeZone={me.timeZone} />
      <AdminShell
        initialCollapsed={initialCollapsed}
        initialTheme={initialTheme}
        messages={messages}
        user={{ displayName: me.displayName, handle: me.handle, accountCode: me.accountCode }}
      >
        {children}
      </AdminShell>
    </ToastProvider>
  );
}
