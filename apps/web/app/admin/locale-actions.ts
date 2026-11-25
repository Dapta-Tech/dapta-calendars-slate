'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';
import { LOCALE_COOKIE } from '@/lib/locale';

/**
 * Persist the admin-UI language and re-render every admin route in the new locale.
 *
 * The choice is also the host's own language (`member.locale`): their emails
 * are written in it, and a link preview of their booking page falls back to it
 * when the robot drawing the preview states no language. The save is awaited,
 * like every dashboard action, with no timeout of its own: the switch stays
 * disabled until the request has settled (`LanguageSwitcher`), so no earlier
 * choice is ever still on its way when a later one is made, and choices are
 * stored in the order they were made. A save that failed is tried once more
 * with the same value. The dashboard's own language still changes if the API is
 * unreachable, and the next choice saves again.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  const value = locale === 'es' ? 'es' : 'en';
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  await saveHostLocale(value);
  revalidatePath('/admin', 'layout');
}

async function saveHostLocale(value: 'en' | 'es'): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await adminApi.updateMyLocale(value);
      return true;
    } catch (e) {
      unstable_rethrow(e);
    }
  }
  return false;
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
