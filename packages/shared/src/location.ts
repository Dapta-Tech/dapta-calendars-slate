/**
 * Rendering the Where — one human string per location, identical on the public
 * booking page, the manage page and the admin surfaces. The kind is a
 * vendor-neutral value (R15); the conferencing platform's display name is
 * injected at runtime by the deployment, never named in this repo (ADR 0008).
 */
import type { BookingMessages } from './i18n';

/** The structural shape of a location; matches `EventLocation` from the engine. */
export interface RenderableLocation {
  kind: string;
  detail?: string | null;
}

function clean(detail: string | null | undefined): string | null {
  const trimmed = typeof detail === 'string' ? detail.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The human Where for a configured location, or null when there is none.
 *
 * `conferencingLabel` is the runtime-injected platform name; null (a bare fork,
 * or no calendar connected) falls back to the generic wording, which is correct
 * — there is no conferencing to name.
 */
export function formatLocation(
  location: RenderableLocation | null | undefined,
  m: BookingMessages,
  conferencingLabel?: string | null,
): string | null {
  if (!location) return null;
  const detail = clean(location.detail);
  switch (location.kind) {
    case 'conferencing':
      return clean(conferencingLabel) ?? m.location.conferencing;
    case 'in_person':
      return detail ? `${m.location.inPerson} · ${detail}` : m.location.inPerson;
    case 'phone':
      return detail ? `${m.location.phone} · ${detail}` : m.location.phone;
    case 'custom':
      // The host authored the whole wording — show it as written. With nothing
      // written there is nothing to say: `m.location.custom` is the EDITOR's
      // option name ("Custom"), and rendering that to an invitee is worse than
      // omitting the row.
      return detail;
    default:
      // An unknown kind must never blank out a location the host did configure.
      return detail;
  }
}

/**
 * The human Where for a BOOKING, from its snapshotted columns. A booking
 * written before the kind existed has `kind === null` and its raw `location`
 * text — render that unchanged so old bookings read exactly as they always did.
 */
export function formatBookingLocation(
  kind: string | null | undefined,
  detail: string | null | undefined,
  m: BookingMessages,
  conferencingLabel?: string | null,
): string | null {
  if (!kind) return clean(detail);
  return formatLocation({ kind, detail }, m, conferencingLabel);
}
