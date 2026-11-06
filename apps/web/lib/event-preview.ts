import 'server-only';
import { adminApi, type Me, type Schedule } from '@/lib/admin-api';
import { resolveAvatarUrl } from '@/lib/avatar';
import { logoOf } from '@/lib/brand-kit';
import { bookingLookOf, type BookingAxes } from '@/lib/booking-look';

/** Who and what the event editor's preview draws around the draft. */
export interface EventPreviewHost {
  hostName: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  accent: string;
  axes: BookingAxes;
  /** The page's address without the event slug (`/acme/alex-rivera`), or null
   *  when the event has no public address yet (no handle, or a team with no slug). */
  basePath: string | null;
}

/**
 * The host's booking-page look and address, for the editor's preview. Read the
 * way the booking-page studio reads it (`bookingLookOf`), so the preview wears
 * the page's real colours. A failed profile read costs the look (defaults are
 * drawn), never the editor.
 */
export async function loadEventPreviewHost(
  me: Me | null,
  team?: { name: string; slug: string | null; logoUrl: string | null },
): Promise<EventPreviewHost> {
  const profile = me?.handle ? await adminApi.profile(me.accountCode, me.handle).catch(() => null) : null;
  const displayName = profile?.member.displayName ?? me?.displayName ?? '';
  const style = (profile?.member.style ?? {}) as Record<string, unknown>;
  const { accent, axes } = bookingLookOf(style, profile?.member.brandColor, displayName);
  const personalAvatar = resolveAvatarUrl(
    profile?.member.avatarUrl,
    style.hideConnectedPhoto === true ? null : profile?.member.connectedAvatarUrl,
  );
  const basePath = !me?.accountCode
    ? null
    : team
      ? team.slug
        ? `/${me.accountCode}/team/${team.slug}`
        : null
      : me.handle
        ? `/${me.accountCode}/${me.handle}`
        : null;
  return {
    hostName: team?.name ?? displayName,
    avatarUrl: team ? team.logoUrl : personalAvatar,
    logoUrl: logoOf(style) ?? null,
    accent,
    axes,
    basePath,
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
