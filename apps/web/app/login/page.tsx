import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { authProvider } from '@/lib/auth-session';
import { PRODUCT_NAME } from '@/lib/product-name';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { firstParam, safeReturnTo, withReturnTo } from '@/lib/return-to';
import { LoginForm } from './login-form';

// The tab says what the page says, in the same language, beside the product
// name the deployment set ("Slate" never surfaces in the UI).
export async function generateMetadata(): Promise<Metadata> {
  const m = getMessages(await getLocale()).admin.login;
  return { title: `${m.title} · ${PRODUCT_NAME}` };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; signedout?: string; next?: string | string[] }>;
}) {
  const m = getMessages(await getLocale()).admin.login;
  const workos = authProvider() === 'workos';
  const { error, signedout, next: rawNext } = await searchParams;
  // Where the sign-in returns to: the dashboard page that sent the person here
  // (a booking opened from an email). Only ever a dashboard path of this app;
  // anything else reads as none, and the sign-in lands on /admin as before.
  const next = safeReturnTo(firstParam(rawNext));

  // Dapta builds: no intermediate sign-in card — go straight to the hosted
  // login. The card only renders as an ERROR landing (?error=) so a failed
  // callback doesn't loop root -> /api/auth/login -> /login -> ...
  if (workos && !error && !signedout) redirect(withReturnTo('/api/auth/login', next));

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      {/* The one screen a signed-out person sees, so it carries the Dapta mark
          rather than a letter chip (#112 / #70). The mark is FIXED-COLOUR
          artwork — a near-white D — so it sits on `--brand-ink`, the constant
          dark tile the sheet carries for exactly this, and stays legible on
          paper. The textual wordmark rides beside it until `L` ships a
          purpose-built Calendars logo. */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-11 w-11 items-center justify-center rounded-md bg-brand-ink">
          <img src="/dapta-mark.png" alt="" width={28} height={28} className="h-7 w-7 object-contain" />
        </span>
        <span className="text-2xl font-semibold tracking-tight">{PRODUCT_NAME}</span>
      </div>

      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6">
        <h1 className="mb-1 text-xl font-semibold">{m.title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{workos ? m.workosSubtitle : m.subtitle}</p>
        {/* A failed WorkOS login/callback comes back with ?error= — surface it
            with a retry CTA instead of a silent plain sign-in screen (R22). */}
        {error ? (
          <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {m.error}
          </p>
        ) : null}
        {workos ? (
          // WorkOS provider: hand off to IAM's hosted login (Google/Microsoft/
          // LinkedIn are rendered by WorkOS — nothing per-provider to build).
          // prompt=login: this button only renders on the signed-out and error
          // landings, where silently re-entering the same account is exactly
          // what the person is trying to escape, so the hosted login must
          // actually ask. The bare /login auto-redirect above stays promptless,
          // keeping the silent SSO for arrivals from the platform.
          <Link
            href={withReturnTo('/api/auth/login?prompt=login', next)}
            className={cn(buttonVariants({ size: 'lg' }), 'w-full')}
          >
            {m.workosCta}
          </Link>
        ) : (
          <LoginForm messages={m} next={next} />
        )}
      </div>

      {!workos ? <p className="max-w-sm text-center text-xs text-muted-foreground">{m.footnote}</p> : null}
    </main>
  );
}
