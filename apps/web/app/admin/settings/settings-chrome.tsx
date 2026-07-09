'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { SettingsTabs } from './settings-tabs';

/** Settings chrome: header + sub-nav for the standard settings pages, but the
 *  booking-page STUDIO renders full-bleed with no header/sub-nav (mirrors the
 *  old app's isStudio mode — header dropped, rail collapsed for full width). */
export function SettingsChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isStudio = pathname.startsWith('/admin/settings/booking-page');

  if (isStudio) return <>{children}</>;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences.</p>
      </header>
      <SettingsTabs />
      {children}
    </div>
  );
}
