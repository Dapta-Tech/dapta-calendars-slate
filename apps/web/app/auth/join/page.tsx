import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMessages, t } from '@slate/shared';
import type { WorkspaceView } from '@slate/types';
import { BrandMark } from '@/components/brand/brand';
import { getSession, hostFetch } from '@/lib/auth-session';
import { getLocale } from '@/lib/locale';
import { PRODUCT_NAME } from '@/lib/product-name';
import { RETURN_TO_PARAM } from '@/lib/return-to';
import { accountCodeFrom, joinPagePath } from '@/lib/workspace-paths';
import { JoinActions } from './join-actions';

// Per request: the answer depends on who is signed in.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const m = getMessages(await getLocale()).admin.invite;
  return { title: `${m.pageTitle} · ${PRODUCT_NAME}`, robots: { index: false, follow: false } };
}

function Card({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-group px-page-x py-page-y">
      {/* Whose page this is, before any name an admin typed. */}
      <div className="flex items-center gap-inline">
        <BrandMark className="h-7 w-auto" />
        <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
      </div>
      <div className="flex w-full max-w-md flex-col gap-group rounded-xl border border-border bg-card p-group">{children}</div>
    </main>
  );
}

/** One read as the person (no workspace header): where they may go, whatever workspace is open. */
async function asPerson<T>(path: string): Promise<T | null> {
  const res = await hostFetch(path, undefined, { workspace: false });
  return res.ok ? ((await res.json()) as T) : null;
}

/**
 * The invitation, as the invited person sees it: which workspace, the role,
 * and a Join button. Joining is that click (a Server Action, so a POST),
 * never a side effect of opening the email's link. Someone signed in with
 * another address, or holding no invitation there, is told so, the same way
 * for an unknown code, so the page never says which workspaces exist.
 *
 * Outside /admin on purpose: the dashboard's onboarding gate would send a
 * brand-new person to the wizard before they could read this.
 */
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = accountCodeFrom((await searchParams).code ?? '');
  const back = code ? joinPagePath(code) : '/admin';
  if (!(await getSession())) redirect(`/login?${RETURN_TO_PARAM}=${encodeURIComponent(back)}`);

  const locale = await getLocale();
  const all = getMessages(locale).admin;
  const m = all.invite;
  const workspaces = code ? ((await asPerson<WorkspaceView[]>('/v1/me/workspaces')) ?? []) : [];
  const match = workspaces.find((w) => w.accountCode.toLowerCase() === code);

  if (match) {
    const role = match.role === 'admin' ? all.members.roleAdmin : all.members.roleMember;
    // Already a member (back from the login, say): the same button just opens it.
    const joined = match.status === 'active';
    return (
      <Card>
        <div className="flex flex-col gap-tight">
          <h1 className="text-xl font-semibold">{t(joined ? m.openTitle : m.joinTitle, { workspace: match.accountName })}</h1>
          <p className="text-sm text-muted-foreground">{joined ? m.openBody : t(m.joinBody, { role })}</p>
        </div>
        <JoinActions accountId={match.accountId} messages={m} joined={joined} />
      </Card>
    );
  }

  const me = await asPerson<{ email?: string | null }>('/v1/me');
  return (
    <Card>
      <div className="flex flex-col gap-tight">
        <h1 className="text-xl font-semibold">{m.notForYouTitle}</h1>
        <p className="text-sm text-muted-foreground">{t(m.notForYouBody, { email: me?.email || '…' })}</p>
      </div>
      <div className="flex flex-col items-center gap-inline sm:flex-row sm:justify-end">
        <Link href="/admin" className="text-sm text-muted-foreground underline underline-offset-4">
          {m.goHome}
        </Link>
        <a
          href={`/api/auth/logout?${RETURN_TO_PARAM}=${encodeURIComponent(back)}`}
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          {m.otherEmail}
        </a>
      </div>
    </Card>
  );
}
