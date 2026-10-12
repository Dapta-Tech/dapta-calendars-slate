import type { AvailabilityResponse, BookingField, Slot } from '@slate/types';
import type { Span } from '@/lib/availability-window';

/**
 * One window of a booking page's availability, as the island receives it.
 *
 * `ok: false` is a read that did not answer at all (the API was unreachable or
 * refused). A read that answered with no times is `ok: true` with an empty
 * list, and `emptyReason` says why when the reason is a configuration one.
 */
export type AvailabilityChunk =
  | {
      ok: true;
      slots: Slot[];
      emptyReason?: string;
      /** The event's intake questions; the island needs them only once. */
      bookingFields?: BookingField[];
    }
  | { ok: false };

/** Which event a page reads availability for. Public identifiers only. */
export interface AvailabilitySource {
  kind: 'personal' | 'team';
  accountCode: string;
  /** Member handle (personal) or team slug (team). */
  owner: string;
  slug: string;
}

/** The parts of an API availability answer a chunk keeps. */
export function toChunk(r: AvailabilityResponse | null): AvailabilityChunk {
  if (!r) return { ok: true, slots: [] };
  return {
    ok: true,
    slots: r.slots,
    ...(r.emptyReason ? { emptyReason: r.emptyReason } : {}),
    bookingFields: r.eventType.bookingFields,
  };
}

/** Same-origin URL the island reads a later window from (`app/api/availability`). */
export function availabilityUrl(source: AvailabilitySource, span: Span): string {
  const qs = new URLSearchParams({
    kind: source.kind,
    accountCode: source.accountCode,
    owner: source.owner,
    slug: source.slug,
    from: new Date(span.fromMs).toISOString(),
    to: new Date(span.toMs).toISOString(),
  });
  return `/api/availability?${qs.toString()}`;
}
