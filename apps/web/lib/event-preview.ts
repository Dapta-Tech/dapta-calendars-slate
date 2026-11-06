import 'server-only';
import { adminApi, type Me, type Schedule } from '@/lib/admin-api';
import { resolveAvatarUrl } from '@/lib/avatar';
import { logoOf } from '@/lib/brand-kit';

/** Who and what the draft preview page draws around the event. */
export interface EventPreviewHost {
  hostName: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  /** The page's own colour and stored style, as `BrandedShell` takes them. */
  brandColor: string | null;
  style: Record<string, unknown>;
}

/**
 * The host's booking-page look, for the draft preview page. Read the way the
 * public page reads it, so the preview wears the page's real colours. A failed
 * profile read costs the look (defaults are drawn), never the page.
 */
export async function loadEventPreviewHost(
  me: Me | null,
  team?: { name: string; slug: string | null; logoUrl: string | null },
): Promise<EventPreviewHost> {
  const profile = me?.handle ? await adminApi.profile(me.accountCode, me.handle).catch(() => null) : null;
  const displayName = profile?.member.displayName ?? me?.displayName ?? '';
  const style = (profile?.member.style ?? {}) as Record<string, unknown>;
  const personalAvatar = resolveAvatarUrl(
    profile?.member.avatarUrl,
    style.hideConnectedPhoto === true ? null : profile?.member.connectedAvatarUrl,
  );
  return {
    hostName: team?.name ?? displayName,
    avatarUrl: team ? team.logoUrl : personalAvatar,
    logoUrl: logoOf(style) ?? null,
    brandColor: profile?.member.brandColor ?? null,
    style,
  };
}

/** The member's working hours (their default schedule), or null when there are none. */
export async function loadWorkingHours(
  schedules: ReadonlyArray<{ id: string; isDefault?: boolean }>,
): Promise<Pick<Schedule, 'timeZone' | 'rules'> | null> {
  const def = schedules.find((s) => s.isDefault) ?? null;
  if (!def) return null;
  return adminApi.getSchedule(def.id).then(
    (s) => ({ timeZone: s.timeZone, rules: s.rules }),
    () => null,
  );
}
