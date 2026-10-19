import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getMessages, t } from '@slate/shared';
import { BrandMark } from '@/components/brand/brand';
import { adminApi, ApiError, type OAuthConsent } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { scopeLabel } from '@/lib/mcp-connect';
import { PRODUCT_NAME } from '@/lib/product-name';
import { firstParam } from '@/lib/return-to';
import { ConsentActions } from './consent-actions';

// Per request: the answer depends on who is signed in and on a live request.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const m = getMessages(await getLocale()).admin.oauthConsent;
  return { title: `${m.pageTitle} · ${PRODUCT_NAME}`, robots: { index: false, follow: false } };
}

/** oidc-provider's interaction ids: URL-safe, bounded. Anything else is not one. */
const UID = /^[A-Za-z0-9_-]{1,128}$/;

function Card({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-group px-page-x py-page-y">
      {/* Whose consent screen this is, before anything the app asserts. */}
      <div className="flex items-center gap-inline">
        <BrandMark className="h-7 w-auto" />
        <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
      </div>
      <div className="flex w-full max-w-md flex-col gap-group rounded-xl border border-border bg-card p-group">{children}</div>
    </main>
  );
}

/**
 * The OAuth consent screen: an app (Claude, ChatGPT, Cursor, an IDE) asks to
 * act on this workspace through the MCP endpoint.
 *
 * Rendering it needs the normal Calendars session: the API call below carries
 * it, and a signed-out person is sent through the login and back here (this
 * path is an allowed return target). The page shows what the person must judge
 * the request by: the app's self-asserted name next to the host it is actually
 * identified by, where the answer goes, the workspace, and the access in plain
 * words. Allow and Deny post to the API, which decides who may approve.
 *
 * Not framable (`/auth` is a product path, see `lib/framing.ts`), so the
 * buttons cannot be clickjacked.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ uid?: string | string[] }> }) {
  const locale = await getLocale();
  const all = getMessages(locale).admin;
  const m = all.oauthConsent;
  const uid = firstParam((await searchParams).uid);

  let details: OAuthConsent | null = null;
  if (uid && UID.test(uid)) {
    try {
      details = await adminApi.oauthConsent(uid);
    } catch (e) {
      // 404: unknown, used or expired. A 401 never gets here: the client
      // redirects through the login (and back) by throwing.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
  }

  if (!details) {
    return (
      <Card>
        <div className="flex flex-col gap-tight">
          <h1 className="text-xl font-semibold">{m.expiredTitle}</h1>
          <p className="text-sm text-muted-foreground">{m.expiredBody}</p>
        </div>
      </Card>
    );
  }

  const { client, account, member } = details;
  const name = client.name ?? m.unnamed;
  const who = member.displayName && member.email ? `${member.displayName} (${member.email})` : (member.email ?? member.displayName ?? '');

  return (
    <Card>
      <div className="flex flex-col gap-tight">
        <h1 className="text-xl font-semibold">{t(m.heading, { client: name, product: PRODUCT_NAME })}</h1>
        {/* The host is what to trust; the name above is the app's own claim. */}
        <p className="text-sm font-medium">{t(m.identifiedAs, { host: client.host })}</p>
        <p className="text-sm text-muted-foreground">{t(m.returnsTo, { host: client.redirectHost })}</p>
      </div>

      {client.loopback ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-field text-sm text-foreground">
          {m.loopbackWarning}
        </p>
      ) : null}

      <div className="flex flex-col gap-tight text-sm">
        <dl className="flex flex-wrap justify-between gap-x-field">
          <dt className="text-muted-foreground">{m.workspace}</dt>
          <dd className="font-medium">
            {account.name} <span className="font-mono text-xs text-muted-foreground">{account.code}</span>
          </dd>
        </dl>
        {who ? <p className="text-muted-foreground">{t(m.signedInAs, { who })}</p> : null}
      </div>

      <div className="flex flex-col gap-inline">
        <h2 className="text-sm font-semibold">{m.scopesLead}</h2>
        <ul className="flex flex-col gap-tight">
          {details.scopes.map((scope) => (
            <li key={scope} className="flex items-center gap-inline text-sm">
              <i aria-hidden className="pi pi-check text-muted-foreground" style={{ fontSize: 12 }} />
              {scopeLabel(all.developer.scopeLabels, scope)}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {details.staysConnected ? t(m.staysConnected, { days: String(details.grantDays) }) : m.shortLived}
        </p>
      </div>

      {details.canApprove ? null : (
        <div className="flex flex-col gap-tight rounded-md border border-dashed border-border p-field">
          <p className="text-sm font-semibold">{m.notAdminTitle}</p>
          <p className="text-sm text-muted-foreground">{m.notAdminBody}</p>
        </div>
      )}

      <ConsentActions uid={details.uid} canApprove={details.canApprove} messages={m} />
    </Card>
  );
}
