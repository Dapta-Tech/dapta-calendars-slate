import { adminApi } from '@/lib/admin-api';
import { defaultBranding } from '@slate/shared';
import { Studio } from './studio';

export const dynamic = 'force-dynamic';

export default async function BookingPageSettings() {
  const me = await adminApi.me().catch(() => null);
  const profile = me?.handle
    ? await adminApi.profile(me.accountCode, me.handle).catch(() => null)
    : null;

  const displayName = profile?.member.displayName ?? me?.displayName ?? 'You';
  const accent = profile?.member.brandColor ?? '#cbe84f';
  const def = defaultBranding(displayName);
  const style = (profile?.member.style ?? {}) as Record<string, string>;
  const axes = {
    template: (style.template as never) ?? def.template,
    cardStyle: (style.cardStyle as never) ?? def.cardStyle,
    corners: (style.corners as never) ?? def.corners,
    buttons: (style.buttons as never) ?? def.buttons,
    density: (style.density as never) ?? def.density,
    font: (style.font as never) ?? def.font,
    slotLayout: (style.slotLayout as never) ?? def.slotLayout,
    dayGroup: (style.dayGroup as never) ?? def.dayGroup,
    slotSelect: (style.slotSelect as never) ?? def.slotSelect,
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Booking Page</h1>
      <p className="mb-8 text-muted-foreground">
        Style your public page. Preview updates live — what you see is what visitors get.
      </p>
      <Studio displayName={displayName} initialAccent={accent} initialAxes={axes} />
    </div>
  );
}
