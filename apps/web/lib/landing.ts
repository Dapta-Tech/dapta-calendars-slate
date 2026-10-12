/**
 * Where a host's link (`/{account}/{handle}`) takes a visitor. One decision,
 * read by the public route (which redirects on it) and by the studio (which
 * says it in words), so what the host is told and what a visitor gets cannot
 * disagree.
 *
 *  - `?landing=1` always opens the profile: the way to see it on purpose.
 *  - The host turned the profile off and chose an event: that event.
 *  - Exactly one bookable event and the host did not ask to always show the
 *    profile (`showProfile`): that event. A profile that lists one thing is a
 *    click between the visitor and the only thing they came for.
 *  - Anything else: the profile.
 *
 * `landingEnabled` is not the opt-out for the single-event case on purpose:
 * the studio has always saved it as `true` with every save, so a stored `true`
 * does not mean a host chose the profile. `showProfile` is only ever written by
 * the host ticking "Always show my profile".
 */
import { t, type BookingMessages } from '@slate/shared';

export type LandingTarget =
  | { kind: 'profile' }
  | { kind: 'event'; slug: string; reason: 'chosen' | 'only-event' };

export function landingTarget({
  style,
  eventSlugs,
  forceProfile = false,
}: {
  style: Record<string, unknown> | null | undefined;
  /** The PUBLIC event types, as the profile would list them. */
  eventSlugs: string[];
  forceProfile?: boolean;
}): LandingTarget {
  if (forceProfile) return { kind: 'profile' };
  const chosen = typeof style?.defaultEventSlug === 'string' ? style.defaultEventSlug : null;
  if (style?.landingEnabled === false && chosen && eventSlugs.includes(chosen)) {
    return { kind: 'event', slug: chosen, reason: 'chosen' };
  }
  if (eventSlugs.length === 1 && style?.showProfile !== true) {
    return { kind: 'event', slug: eventSlugs[0]!, reason: 'only-event' };
  }
  return { kind: 'profile' };
}

/** `?landing=1` (any truthy spelling of it) asks for the profile itself. */
export function wantsProfile(query: Record<string, string | string[] | undefined>): boolean {
  const v = query.landing;
  const one = Array.isArray(v) ? v[0] : v;
  return one === '1' || one === 'true';
}

/** The studio's sentence for a target: what a visitor gets from the link. */
export function describeLanding(
  target: LandingTarget,
  events: Array<{ slug: string; title: string }>,
  m: Pick<BookingMessages['admin']['studio'], 'linkOpensEvent' | 'linkOpensProfile'>,
): string {
  if (target.kind === 'profile') return m.linkOpensProfile;
  const title = events.find((e) => e.slug === target.slug)?.title ?? target.slug;
  return t(m.linkOpensEvent, { event: title });
}
