'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/session';

/** OSS local auth: a FE session cookie gates the dashboard so sign-in / sign-out
 *  are real flows. The WorkOS provider (BE) replaces this in a prod deploy —
 *  this is deliberately the local/dev provider (no external identity). */
export async function signInAction(): Promise<void> {
  const secure = process.env.NODE_ENV === 'production';
  (await cookies()).set(SESSION_COOKIE, '1', {
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });
  redirect('/admin');
}

export async function signOutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
