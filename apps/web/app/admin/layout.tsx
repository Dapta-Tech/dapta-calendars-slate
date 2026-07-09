import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { AdminShell } from '@/components/admin-shell';
import { ToastProvider } from '@/components/toast';
import { SESSION_COOKIE } from '@/lib/session';
import { getLocale } from '@/lib/locale';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  // Local-auth gate: no session → the sign-in screen (WorkOS replaces this in prod).
  if (!jar.get(SESSION_COOKIE)) redirect('/login');

  let me: Awaited<ReturnType<typeof adminApi.me>> | null = null;
  try {
    me = await adminApi.me();
  } catch {
    me = null;
  }

  // Server-read the collapse pref so the sidebar renders at the right width on
  // first paint (no rail FOUC).
  const initialCollapsed = jar.get('slate.nav.collapsed')?.value === '1';
  const messages = getMessages(await getLocale()).admin;

  return (
    <ToastProvider>
      <AdminShell
        initialCollapsed={initialCollapsed}
        messages={messages}
        user={
          me
            ? { displayName: me.displayName, handle: me.handle, accountCode: me.accountCode }
            : null
        }
      >
        {children}
      </AdminShell>
    </ToastProvider>
  );
}
