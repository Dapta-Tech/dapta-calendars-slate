/**
 * Round-robin host selection — the "getLuckyUser" seam (cal.diy
 * `packages/features/bookings/lib/getLuckyUser`). Pure and deterministic so it
 * unit-tests without a DB.
 *
 * Contract (API-CONTRACT §Engine rules 1): the host is picked AFTER a slot is
 * selected, from the pool of hosts actually free at that slot. Fairness order:
 *   1. highest `priority` wins outright;
 *   2. among equal priority, weighted least-load — lowest
 *      bookingCount / weight (so a weight-200 host absorbs ~2× a weight-100 host);
 *   3. tie-break by least-recently-booked, then memberId (stable).
 *
 * Wave 1 books against a single host; collective multi-host is Wave 2 but the
 * selection seam is shaped now (fixed hosts bypass this — they're always present).
 */

export interface HostCandidate {
  memberId: string;
  /** Higher = preferred. Absent → 0. */
  priority?: number | null;
  /** Relative load share. Absent/≤0 → 100. */
  weight?: number | null;
  /** Accepted bookings assigned to this host (load signal). */
  bookingCount: number;
  /** When this host was last booked (recency tie-break). Null = never. */
  lastBookedAt?: Date | null;
}

/**
 * Pick the fair host from a pool of candidates already known to be FREE at the
 * target slot. Returns null only for an empty pool.
 */
export function selectLuckyHost(candidates: HostCandidate[]): HostCandidate | null {
  if (candidates.length === 0) return null;

  const maxPriority = Math.max(...candidates.map(c => c.priority ?? 0));
  const pool = candidates.filter(c => (c.priority ?? 0) === maxPriority);

  return pool.reduce((best, cur) => (isBetter(cur, best) ? cur : best));
}

/** True if `a` should be preferred over `b` (lower weighted load, then recency). */
function isBetter(a: HostCandidate, b: HostCandidate): boolean {
  const la = weightedLoad(a);
  const lb = weightedLoad(b);
  if (la !== lb) return la < lb;

  const ra = a.lastBookedAt ? a.lastBookedAt.getTime() : -Infinity; // never-booked = most stale
  const rb = b.lastBookedAt ? b.lastBookedAt.getTime() : -Infinity;
  if (ra !== rb) return ra < rb;

  return a.memberId < b.memberId; // stable, deterministic
}

function weightedLoad(c: HostCandidate): number {
  const weight = c.weight && c.weight > 0 ? c.weight : 100;
  return c.bookingCount / weight;
}
