import { redirect } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi, ApiError } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { OnboardingWizard } from './wizard';

export const dynamic = 'force-dynamic';

/**
 * The ONE onboarding route (ADR 0002). It runs whichever gates apply and skips
 * the rest, so an invited member lands directly on the template picker rather
 * than being asked commercial questions about someone else's company.
 *
 * Two routes were rejected because they duplicate layout, guards and i18n copy
 * for nothing; a modal was rejected because it makes the first event type feel
 * optional at the exact moment it is the only thing that makes a host bookable.
 */
export default async function OnboardingPage() {
  let state: Awaited<ReturnType<typeof adminApi.onboardingState>>;
  try {
    state = await adminApi.onboardingState();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login');
    throw e;
  }

  // Owes nothing: never strand someone on a wizard with no steps. This also
  // closes the loop with the admin guard — the two agree on one server verdict,
  // so neither can bounce the host back and forth.
  if (!state.onboardingRequired && !state.setupRequired) redirect('/admin');

  const m = getMessages(await getLocale());

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-6 py-12">
      <OnboardingWizard state={state} messages={m.onboarding} />
    </main>
  );
}
