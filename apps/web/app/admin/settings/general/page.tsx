import { adminApi } from '@/lib/admin-api';
import { GeneralForm } from './general-form';

export const dynamic = 'force-dynamic';

export default async function GeneralSettings() {
  const me = await adminApi.me().catch(() => null);
  const profile = me?.handle
    ? await adminApi.profile(me.accountCode, me.handle).catch(() => null)
    : null;

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">General</h1>
      <GeneralForm
        displayName={me?.displayName ?? ''}
        handle={me?.handle ?? ''}
        accountCode={me?.accountCode ?? ''}
        timeZone={(profile?.member as { timeZone?: string })?.timeZone ?? 'UTC'}
      />
    </div>
  );
}
