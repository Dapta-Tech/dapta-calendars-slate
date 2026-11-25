'use server';

import { cookies } from 'next/headers';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';
import { LOCALE_COOKIE } from '@/lib/locale';

/**
 * Persist the admin-UI language and re-render every admin route in the new locale.
 *
 * The choice is also the host's own language (`member.locale`): their emails
 * are written in it, and a link preview of their booking page falls back to it
 * when the robot drawing the preview states no language. Saving it there runs
 * after the response (`after`) and is best effort: the switch never waits on
 * the API, and still works if the API is briefly unreachable.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  const value = locale === 'es' ? 'es' : 'en';
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  after(async () => {
    try {
      await adminApi.updateMyLocale(value);
    } catch {
      // Best effort: the dashboard records it again on a later visit while empty.
    }
  });
  revalidatePath('/admin', 'layout');
}

/**
 * The first time the dashboard renders for a host with no language on record,
 * record the one it renders in (the saved switch, else the browser's). The API
 * keeps it only while the host still has none (AdminService.syncClientLocale).
 */
export async function syncLocaleAction(locale: string): Promise<void> {
  if (locale !== 'en' && locale !== 'es') return;
  try {
    await adminApi.syncLocale(locale);
  } catch (e) {
    unstable_rethrow(e);
  }
}
