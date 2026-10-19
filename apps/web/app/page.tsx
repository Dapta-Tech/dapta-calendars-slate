import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { authProvider, getSession } from '@/lib/auth-session';
import { getLocale } from '@/lib/locale';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

// Customer-facing name (build-time inlined); "Slate" never surfaces in the UI.
const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

// Per-request render: the workos-vs-local branch reads RUNTIME env + cookies.
// Without this, next build (no AUTH_PROVIDER in the builder) bakes the OSS
// landing statically and production serves it to anonymous users.
export const dynamic = 'force-dynamic';

/**
 * Root behavior depends on the deployment flavor:
 *  - workos (Dapta production): the root is an APP entry, never a marketing
 *    page — logged-in users land on /admin, anonymous users go STRAIGHT to the
 *    hosted login (no intermediate sign-in card).
 *  - local/OSS fork: keep the clone-and-run landing with the demo booking page.
 */
export default async function HomePage() {
  if (authProvider() === 'workos') {
    const session = await getSession();
    redirect(session ? '/admin' : '/api/auth/login');
  }

  // In the document's language, which `<html lang>` already declares.
  const m = getMessages(await getLocale()).site;
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground">
          {productName}
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">{m.devLandingTitle}</h1>
        <p className="max-w-md text-muted-foreground">{m.devLandingBody}</p>
      </div>

      {/* A2 (#112): was a text link wearing an arrow. The OSS root is the door
          to /login on this build, so it takes the sweep's arrow rule with the
          login screen even though the stub's scope list stops one route short —
          otherwise it belongs to no unit at all. */}
      <Link href="/acme/alex-rivera" className={cn(buttonVariants({ size: 'lg' }), 'px-6')}>
        <i aria-hidden className="pi pi-external-link" style={{ fontSize: 14 }} />
        {m.devLandingCta}
      </Link>

      <p className="text-sm text-muted-foreground">
        {m.devLandingTry} <code className="rounded-sm bg-muted px-1.5 py-0.5">/acme/alex-rivera/intro-call</code>
      </p>
    </main>
  );
}
