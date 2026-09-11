import { adminApi } from '@/lib/admin-api';
import { DEFAULT_ACCENT, defaultBranding, getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { Studio } from './studio';

export const dynamic = 'force-dynamic';

export default async function BookingPageSettings() {
  const me = await adminApi.me();
  const [profile, adminEvents, locale, vanity] = await Promise.all([
    me?.handle ? adminApi.profile(me.accountCode, me.handle) : Promise.resolve(null),
    adminApi.listEventTypes(),
    getLocale(),
    adminApi.vanityStatus().catch(() => ({ vanitySlug: null, shortCode: '', canClaim: false })),
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
      <Studio
        messages={t.studio}
        opensNewTab={t.common.opensNewTab}
        embedMessages={msgs.embed}
        // The preview draws a month grid, and month names, weekday initials and
        // which day a week starts on are all locale decisions — so the preview
        // needs the locale itself, not only the resolved copy.
        locale={locale}
        accountCode={me?.accountCode ?? ''}
        vanity={{ ...vanity, shortCode: vanity.shortCode || me?.accountShortCode || '' }}
        subscriptionUrl={process.env.NEXT_PUBLIC_SIGNUP_URL ?? null}
        displayName={displayName}
        handle={me?.handle ?? ''}
        bio={(style.bio as string) ?? ''}
        avatarUrl={profile?.member.avatarUrl ?? ''}
        // The preview's fallback, NOT the input's value: the field stays the
        // host's own choice, and the preview still draws what the live page
        // draws when that choice is empty.
        connectedAvatarUrl={profile?.member.connectedAvatarUrl ?? ''}
        coverUrl={profile?.member.coverUrl ?? ''}
        accent={accent}
        axes={axes}
        landingEnabled={style.landingEnabled !== false}
        defaultEventSlug={(style.defaultEventSlug as string) ?? null}
        eventTypes={profile?.eventTypes ?? []}
        manageableEvents={adminEvents.map((e) => ({ id: e.id, slug: e.slug, title: e.title, hidden: e.hidden }))}
        eventOrder={Array.isArray(style.eventOrder) ? (style.eventOrder as string[]) : []}
      />
    </div>
  );
}
