'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';
import { LOCALE_COOKIE } from '@/lib/locale';

/** How long the switch may wait on the API before it lets the host go on. */
const SAVE_TIMEOUT_MS = 4000;

/**
 * Persist the admin-UI language and re-render every admin route in the new locale.
 *
 * The choice is also the host's own language (`member.locale`): their emails
 * are written in it, and a link preview of their booking page falls back to it
 * when the robot drawing the preview states no language. The save is awaited:
 * the switch stays disabled until it answers (`LanguageSwitcher`), so two quick
 * choices are stored in the order they were made. A failed save is tried once
 * more; the dashboard's own language still changes if the API is unreachable,
 * and the next choice saves again.
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
  const deadline = Date.now() + SAVE_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        adminApi.updateMyLocale(value),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), left);
        }),
      ]);
      return true;
    } catch (e) {
      unstable_rethrow(e);
    } finally {
      clearTimeout(timer);
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
