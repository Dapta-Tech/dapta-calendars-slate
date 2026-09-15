/**
 * Location kind — WHERE a meeting happens, as a vendor-neutral value (R15).
 *
 * The kind is configured on the event type (stored in the existing
 * `event_type.locations` column) and SNAPSHOTTED onto every booking
 * (`booking.location_kind`), so a host editing the event type later never
 * retroactively rewrites what a past booking meant.
 *
 * Pure by construction — this module normalizes values and performs no I/O,
 * which is what lets `@slate/db`, `@slate/types`, the API and the web app all
 * agree on one reading of the column.
 */

/** The four ways a meeting can happen. No vendor is named, ever. */
export const LOCATION_KINDS = ['conferencing', 'in_person', 'phone', 'custom'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface EventLocation {
  kind: LocationKind;
  /**
   * The free text the kind needs — an address, a phone number, or the custom
   * label. Always null for `conferencing`: that link is minted by the calendar
   * port at write-out, never typed by the host.
   */
  detail: string | null;
}

/**
 * The loose shape a caller may hand in (an API body, a form): `detail` may be
 * absent, null, or a string. `parseEventLocation` narrows it to `EventLocation`.
 */
export interface EventLocationInput {
  kind: LocationKind;
  detail?: string | null;
}

/**
 * The one legacy stored value that meant "mint an automatic meeting link".
 *
 * This is the single place the retired token is spelled. It is read-only
 * compatibility for rows written before the location kind existed:
 * `parseEventLocation` maps it onto `conferencing`, nothing ever writes it
 * again, and the conferencing TRIGGER no longer reads it at all. Exported so
 * tests and migrations reference it rather than re-spelling it.
 */
export const LEGACY_CONFERENCING_VALUE = 'google_meet';

export function isLocationKind(value: unknown): value is LocationKind {
  return typeof value === 'string' && (LOCATION_KINDS as readonly string[]).includes(value);
}

/**
 * The contract cap on a location detail. Enforced HERE as a clamp, not only as
 * input validation: `event_type.locations` can hold text written before the cap
 * existed (or by a direct SQL/importer path), and the public availability
 * response parses the same schema — truncating degrades, rejecting would 500.
 */
export const LOCATION_DETAIL_MAX = 500;

/** Trim to a non-empty string within the cap, or null. */
function cleanDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, LOCATION_DETAIL_MAX);
}

/**
 * Normalize whatever `event_type.locations` holds into a location kind.
 *
 * Accepts BOTH shapes, which is what makes the column additive with zero
 * migration:
 *   - `{ kind, detail? }`             → itself, detail normalized
 *   - the legacy conferencing literal → `{ kind: 'conferencing', detail: null }`
 *   - any other non-empty string      → `{ kind: 'custom', detail: <string> }`
 *   - null / blank / anything else    → null (no location configured)
 *
 * Idempotent: re-parsing its own output is a no-op.
 */
export function parseEventLocation(value: unknown): EventLocation | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed === LEGACY_CONFERENCING_VALUE) return { kind: 'conferencing', detail: null };
    return { kind: 'custom', detail: trimmed.slice(0, LOCATION_DETAIL_MAX) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { kind, detail } = value as { kind?: unknown; detail?: unknown };
    if (!isLocationKind(kind)) return null;
    // Conferencing carries no host-authored detail — see EventLocation.detail.
    return { kind, detail: kind === 'conferencing' ? null : cleanDetail(detail) };
  }
  return null;
}
