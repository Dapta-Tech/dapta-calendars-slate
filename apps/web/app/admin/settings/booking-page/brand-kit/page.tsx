import { getMessages } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { StudioTabs } from '../studio-tabs';
import { BrandKitPanel } from './brand-kit-panel';

export const dynamic = 'force-dynamic';

/**
 * The workspace brand kit, beside the host's own studio. One logo, accent,
 * canvas and shape for every page in the workspace. A host applies it from
 * their studio (a snapshot they can revert); team pages wear it directly.
 * Everyone can see it; only an admin or owner can change it (the API enforces
 * that too).
 */
export default async function BrandKitPage() {
  const [me, locale, kit] = await Promise.all([
    adminApi.me(),
    getLocale(),
    adminApi.getBrandKit().catch(() => ({ config: null, updatedAt: null })),
  ]);
  const msgs = getMessages(locale);
  return (
    <div className="mx-auto max-w-6xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <BrandKitPanel
        initialKit={kit.config ?? {}}
        updatedAt={kit.updatedAt}
        canEdit={isAdminRole(me?.role ?? 'member')}
        bk={msgs.admin.brandKit}
        studio={msgs.admin.studio}
        locale={locale}
        hostName={me?.displayName ?? me?.handle ?? ''}
        tabs={<StudioTabs yourPage={msgs.admin.studio.tabYourPage} brandKit={msgs.admin.studio.tabBrandKit} />}
      />
    </div>
  );
}
