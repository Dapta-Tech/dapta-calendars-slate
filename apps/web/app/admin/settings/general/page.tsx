import { adminApi } from '@/lib/admin-api';
import { GeneralForm } from './general-form';

export const dynamic = 'force-dynamic';

export default async function GeneralSettings() {
  const me = await adminApi.me();
  const profile = me?.handle
    ? await adminApi.profile(me.accountCode, me.handle)
    : null;

  return (
    <div className="max-w-2xl">
      <GeneralForm
        displayName={me?.displayName ?? ''}
        handle={me?.handle ?? ''}
        accountCode={me?.accountCode ?? ''}
        timeZone={(profile?.member as { timeZone?: string })?.timeZone ?? 'UTC'}
      />
    </div>
  );
}
