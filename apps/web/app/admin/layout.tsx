import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { adminApi } from '@/lib/admin-api';
import { AdminShell } from '@/components/admin-shell';
import { ToastProvider } from '@/components/toast';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let me: Awaited<ReturnType<typeof adminApi.me>> | null = null;
  try {
    me = await adminApi.me();
  } catch {
    me = null;
  }

  // Server-read the collapse pref so the sidebar renders at the right width on
  // first paint (no rail FOUC).
  const initialCollapsed = (await cookies()).get('slate.nav.collapsed')?.value === '1';

  return (
    <ToastProvider>
      <AdminShell
        initialCollapsed={initialCollapsed}
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
