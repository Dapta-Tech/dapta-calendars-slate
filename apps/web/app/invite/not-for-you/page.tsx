import Link from 'next/link';
import { redirect, unstable_rethrow } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getSession } from '@/lib/auth-session';
import { getLocale } from '@/lib/locale';
import { RETURN_TO_PARAM } from '@/lib/return-to';
import { accountCodeFrom, adminJoinPath } from '@/lib/workspace-paths';

/**
 * An invitation link opened by someone it was not sent to: signed in with
 * another address, or the invitation was taken back. Names the address they
 * are signed in with and offers to sign in with another one, coming back to
 * the same link. Outside /admin on purpose: the dashboard's onboarding gate
 * would send a brand-new person to the wizard before they could read this.
 */
export default async function NotForYou({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = accountCodeFrom((await searchParams).code ?? '');
  const join = code ? adminJoinPath(code) : '/admin';
  if (!(await getSession())) redirect(`/login?${RETURN_TO_PARAM}=${encodeURIComponent(join)}`);

  const m = getMessages(await getLocale()).admin.invite;
  let email = '';
  try {
    email = (await adminApi.me()).email ?? '';
  } catch (e) {
    unstable_rethrow(e); // a refresh or sign-out redirect must still happen
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">{m.notForYouTitle}</h1>
      <p className="text-muted-foreground">{t(m.notForYouBody, { email: email || '…' })}</p>
      <div className="flex flex-col items-center gap-2">
        <a
          href={`/api/auth/logout?${RETURN_TO_PARAM}=${encodeURIComponent(join)}`}
          className="text-primary underline underline-offset-4"
        >
          {m.otherEmail}
        </a>
        <Link href="/admin" className="text-muted-foreground underline underline-offset-4">
          {m.goHome}
        </Link>
      </div>
    </main>
  );
}
