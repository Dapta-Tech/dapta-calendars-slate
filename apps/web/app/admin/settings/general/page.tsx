import { getMessages, safeTimeZone } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { LanguageSwitcher } from '@/components/language-switcher';
import { GeneralForm } from './general-form';
import { BrandingSetting } from './branding-setting';
import { BRANDING_UNREAD } from './branding-unread';

export const dynamic = 'force-dynamic';

export default async function GeneralSettings() {
  const me = await adminApi.me();
  const [profile, branding] = await Promise.all([
    me?.handle ? adminApi.profile(me.accountCode, me.handle) : null,
    adminApi.brandingStatus().catch(() => BRANDING_UNREAD),
  ]);
  const locale = await getLocale();
  const m = getMessages(locale).admin;

  return (
    <div className="flex max-w-2xl flex-col gap-section">
      <GeneralForm
        displayName={me?.displayName ?? ''}
        handle={me?.handle ?? ''}
        accountCode={me?.accountCode ?? ''}
        timeZone={safeTimeZone((profile?.member as { timeZone?: string })?.timeZone)}
        messages={m.settingsGeneral}
        locale={locale}
      />
      {/* An account-level switch, so it sits apart from the member's own fields
          above. Every role reads it; owners and admins change it. */}
      <BrandingSetting
        initial={branding}
        canEdit={me ? isAdminRole(me.role) : false}
        platformUrl={process.env.NEXT_PUBLIC_PLATFORM_URL || null}
        messages={m.brandingSetting}
      />
      <div className="border-t border-border pt-group">
        <LanguageSwitcher locale={locale} label={m.common.language} />
      </div>
    </div>
  );
}
