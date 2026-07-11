import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { authProvider } from '@/lib/auth-session';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — Slate' };

export default async function LoginPage() {
  const m = getMessages(await getLocale()).admin.login;
  const workos = authProvider() === 'workos';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary px-2.5 py-1 text-base font-semibold text-primary-foreground">S</span>
        <span className="text-2xl font-semibold tracking-tight">Slate</span>
      </div>

      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6">
        <h1 className="mb-1 text-xl font-semibold">{m.title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{workos ? m.workosSubtitle : m.subtitle}</p>
        {workos ? (
          // WorkOS provider: hand off to IAM's hosted login (Google/Microsoft/
          // LinkedIn are rendered by WorkOS — nothing per-provider to build).
          <Link
            href="/api/auth/login"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition-transform active:scale-[0.99]"
          >
            {m.workosCta}
          </Link>
        ) : (
          <LoginForm messages={m} />
        )}
      </div>

      {!workos ? <p className="max-w-sm text-center text-xs text-muted-foreground">{m.footnote}</p> : null}
    </main>
  );
}
