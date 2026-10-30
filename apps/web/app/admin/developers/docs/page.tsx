import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { apiDocsNavHref } from '@/lib/admin-nav';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';

// Read per request: the API's public origin is runtime env (see mcp-config.ts).
export const dynamic = 'force-dynamic';

/**
 * The old address of API docs. The rail's item now opens the API's own
 * reference (the try-it console, with a link to the OpenAPI document) in a new
 * tab, so this only sends a link made before straight there. The reference is
 * never drawn inside the dashboard: it stays on the API's origin. A member
 * still gets the no-access panel, as for the rest of API and webhooks; a
 * deployment that does not say where its API is served says so.
 */
export default async function DeveloperDocsPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  const title = admin.developerNav.docs;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={title} />;
  const reference = apiDocsNavHref(resolveMcpConfig().apiOrigin);
  if (reference) redirect(reference);
  return (
    <DeveloperPage title={title}>
      <p className="mt-section max-w-prose text-sm text-muted-foreground">{admin.developer.apiRefMissing}</p>
    </DeveloperPage>
  );
}
