import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { documentLocale } from '@/lib/locale';

/**
 * Where a link that leads nowhere lands: an unknown host, team or event, or a
 * path that is no route at all. In the language the document itself is
 * stamped in (`documentLocale`, as `<html lang>` is), so a Spanish visitor's
 * dead link is a Spanish page rather than English words under `lang="es"`.
 *
 * Next marks every 404 response `noindex` on its own, and since the existence
 * checks moved above the loading boundaries this page is served with a real
 * 404 status, so a search engine drops it either way.
 *
 * What a 404 decided DURING render costs: Next answers it with a server-rendered
 * head (status, `noindex`, the site title) and draws this body in the browser.
 * A path that matches no route at all renders it on the server as usual. A
 * fully server-rendered body for an unknown host would need the existence check
 * in the middleware, which is a second API read on every public page request.
 */
export default async function NotFound() {
  const m = getMessages(await documentLocale()).site;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-semibold">{m.notFoundTitle}</h1>
      <p className="text-muted-foreground">{m.notFoundBody}</p>
      <Link href="/" className="text-primary underline underline-offset-4">
        {m.notFoundHome}
      </Link>
    </main>
  );
}
