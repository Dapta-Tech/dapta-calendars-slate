import { adminApi } from '@/lib/admin-api';
import { connectedPhotoOf } from '@/lib/avatar';
import { brandingShown } from '@/lib/growth';
import { DEFAULT_ACCENT, defaultBranding, getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { Studio } from './studio';
import { StudioTabs } from './studio-tabs';
import { hasBrandKit } from '@slate/types';
import { logoOf } from '@/lib/brand-kit';

export const dynamic = 'force-dynamic';

export default async function BookingPageSettings() {
  const me = await adminApi.me();
  const [profile, adminEvents, locale, vanity, lookState, kit, connections] = await Promise.all([
    me?.handle ? adminApi.profile(me.accountCode, me.handle) : Promise.resolve(null),
    adminApi.listEventTypes(),
    getLocale(),
    adminApi.vanityStatus().catch(() => ({ vanitySlug: null, shortCode: '', canClaim: false })),
    // A failed read costs the Revert control, never the studio.
    adminApi.bookingPageState().catch(() => ({ backup: null })),
    // Same rule: a failed read costs "Apply brand kit", never the studio.
    adminApi.getBrandKit().catch(() => ({ config: null, updatedAt: null })),
    // Only for the connected photo: a studio that cannot list connections still
    // opens, it just has no photo to offer.
    adminApi.listConnections().catch(() => []),
  ]);
  const msgs = getMessages(locale);
  const t = msgs.admin;

  const displayName = profile?.member.displayName ?? me?.displayName ?? 'You';
  // The literal used to live here. If DEFAULT_ACCENT ever moves, a hardcoded
  // copy seeds the studio from a colour the public page would never render —
  // preview != prod, one indirection out.
  const accent = profile?.member.brandColor ?? DEFAULT_ACCENT;
  const style = (profile?.member.style ?? {}) as Record<string, unknown>;
  const def = defaultBranding(displayName);
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
    // Through the resolver, never a literal at the call site: an absent axis
    // resolves in exactly one place, and the studio has to agree with the public
    // page about what a config saved before B2 renders as. The literal has moved
    // once already (ADR 0004's amendment), which is the reason for the rule.
    theme: bookingCanvasOf(style),
  };

  return (
    <div className="mx-auto max-w-6xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <h1 className="mb-tight text-3xl font-semibold tracking-tight">{t.bookingPageHeader.title}</h1>
      <p className="mb-group text-muted-foreground">{t.bookingPageHeader.subtitle}</p>
      <StudioTabs yourPage={t.studio.tabYourPage} brandKit={t.studio.tabBrandKit} />
      <Studio
        // Remounted from what is stored when an applied look appears or goes:
        // a revert writes the stored look back, and the studio's own state has
        // to start from it rather than from the look it just replaced.
        key={lookState.backup?.appliedAt ?? 'none'}
        lookBackup={lookState.backup}
        logoUrl={logoOf(style) ?? ''}
        hasBrandKit={hasBrandKit(kit.config)}
        messages={t.studio}
        opensNewTab={t.common.opensNewTab}
        embedMessages={msgs.embed}
        // The preview draws a month grid, and month names, weekday initials and
        // which day a week starts on are all locale decisions — so the preview
        // needs the locale itself, not only the resolved copy.
        locale={locale}
        accountCode={me?.accountCode ?? ''}
        vanity={{ ...vanity, shortCode: vanity.shortCode || me?.accountShortCode || '' }}
        // The Dapta AI app, like the branding setting's "Included with your Dapta
        // AI subscription". Not the signup URL: that one is where the "Made
        // with" links send visitors, which can be the product's own site.
        subscriptionUrl={process.env.NEXT_PUBLIC_PLATFORM_URL || null}
        // The profile preview ends as the live profile does: with the
        // free-calendar block only while the account's pages carry the branding.
        showBranding={brandingShown(profile)}
        displayName={displayName}
        handle={me?.handle ?? ''}
        bio={(style.bio as string) ?? ''}
        avatarUrl={profile?.member.avatarUrl ?? ''}
        // The preview's fallback, NOT the input's value: the field stays the
        // host's own choice, and the preview still draws what the live page
        // draws when that choice is empty. From the host's own connections, so
        // it is still known after the host removed it from the page.
        connectedAvatarUrl={connectedPhotoOf(connections) ?? profile?.member.connectedAvatarUrl ?? ''}
        hideConnectedPhoto={style.hideConnectedPhoto === true}
        coverUrl={profile?.member.coverUrl ?? ''}
        accent={accent}
        axes={axes}
        landingEnabled={style.landingEnabled !== false}
        showProfile={style.showProfile === true}
        defaultEventSlug={(style.defaultEventSlug as string) ?? null}
        eventTypes={profile?.eventTypes ?? []}
        accountName={profile?.account.name ?? null}
        manageableEvents={adminEvents.map((e) => ({ id: e.id, slug: e.slug, title: e.title, hidden: e.hidden }))}
        eventOrder={Array.isArray(style.eventOrder) ? (style.eventOrder as string[]) : []}
      />
    </div>
  );
}
