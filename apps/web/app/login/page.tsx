import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { signInAction } from './actions';

export const metadata = { title: 'Sign in — Slate' };

export default async function LoginPage() {
  const m = getMessages(await getLocale()).admin.login;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary px-2.5 py-1 text-base font-semibold text-primary-foreground">S</span>
        <span className="text-2xl font-semibold tracking-tight">Slate</span>
      </div>

      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6">
        <h1 className="mb-1 text-xl font-semibold">{m.title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{m.subtitle}</p>
        <form action={signInAction}>
          <button
            type="submit"
            className="w-full rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition-transform active:scale-[0.99]"
          >
            {m.continue}
          </button>
        </form>
      </div>

      <p className="text-xs text-muted-foreground">{m.footnote}</p>
    </main>
  );
}
