import type { ReactNode } from 'react';
import { adminApi } from '@/lib/admin-api';
import { AdminShell } from '@/components/admin-shell';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let me: Awaited<ReturnType<typeof adminApi.me>> | null = null;
  try {
    me = await adminApi.me();
  } catch {
    me = null;
  }

  return (
    <AdminShell
      user={
        me
          ? { displayName: me.displayName, handle: me.handle, accountCode: me.accountCode }
          : null
      }
    >
      {children}
    </AdminShell>
  );
}
