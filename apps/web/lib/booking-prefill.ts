import { normalizeBookingPrefill, type BookingPrefill } from '@slate/types';
import type { RawSearchParams } from '@/lib/embed';

/**
 * The prefill a booking page starts its form with, read from the page's own
 * address (`normalizeBookingPrefill`).
 *
 * The sibling of `utmFromQuery`, and deliberately simpler: there is no
 * framing-page fallback. A campaign is a property of the VISIT, which an embed
 * may only be able to learn from its host page; a prefill is a value the page
 * that built this URL already had, so it is in the URL or it is nowhere. An
 * embed that wants one puts it in the `src`.
 */
export function prefillFromQuery(query: RawSearchParams | undefined): BookingPrefill | null {
  if (!query) return null;
  // The FIRST value of each key, as `utmFromQuery` takes it: a repeated
  // parameter is an address built twice over, not two answers to one question.
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') raw[key] = first;
  }
  return normalizeBookingPrefill(raw);
}
