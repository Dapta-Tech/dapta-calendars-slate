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

/**
 * A plain decimal: an optional minus sign, digits, and an optional fraction
 * that has digits of its own. The ONE shape a prefilled number is allowed to
 * have, because it is the one every browser's `<input type="number">` keeps
 * and the one a person types. JavaScript's `Number()` reads far more (`0x10`,
 * `0b10`, `1e3`, `Infinity`, a lone space) and a browser empties the input for
 * most of those, so the state would hold a value the field submits blank and
 * the required check would pass on it. No surrounding whitespace is accepted
 * here: `normalizeBookingPrefill` already trims, and a caller that did not
 * should see the value refused rather than quietly repaired.
 */
const PLAIN_NUMBER_RE = /^-?(?:\d+|\d*\.\d+)$/;

export function isPlainNumber(value: string): boolean {
  return PLAIN_NUMBER_RE.test(value);
}
