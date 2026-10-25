import type { ReactNode } from 'react';
import { getMessages, type Locale } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/ui/page-header';

/**
 * Who may open the agent and API pages (connect, Tools, keys, webhooks, API
 * docs), asked once per page. They are admin/owner-only (the API 403s a plain
 * member, and a sign-in reaches only workspaces where the person is an owner
 * or admin), so a member never gets the rail items; this answers one who
 * arrives by address, with a message rather than an error. Checked on every page and not in a layout: a layout is not
 * re-rendered on client navigation, and the page's own reads would 403 first.
 */
export async function developerAccess(): Promise<{ locale: Locale; allowed: boolean }> {
  const [me, locale] = await Promise.all([adminApi.me(), getLocale()]);
  return { locale, allowed: isAdminRole(me.role) };
}

/**
 * The frame the API and webhooks pages share: the settings width, a list-page
 * header, prose-width content. Without a `title` the content brings its own
 * header (Webhooks, whose create action lives with the list's state).
 */
export function DeveloperPage({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    // 16px of gutter at 360px, the full 32 from `sm` up (R28), like Settings.
    <div className="mx-auto max-w-5xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      {/* `longSubtitle` keeps the lead at reading width, inside the column below. */}
      {title ? <PageHeader title={title} subtitle={subtitle} longSubtitle /> : null}
      {/* Block flow, not a flex gap: each section keeps the margin it always
          had, and neighbouring margins collapse into one section step. */}
      <div className="max-w-3xl">{children}</div>
    </div>
  );
}

/** A member who typed the address: the page's frame, with the no-access panel in it. */
export function DeveloperNoAccess({ locale, title }: { locale: Locale; title: string }) {
  const nm = getMessages(locale).admin.members;
  return (
    <DeveloperPage title={title}>
      <NoAccess title={nm.noAccessTitle} body={nm.noAccessBody} />
    </DeveloperPage>
  );
}
