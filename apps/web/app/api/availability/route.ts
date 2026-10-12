import { NextResponse, type NextRequest } from 'next/server';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import { getAvailability, getTeamAvailability } from '@/lib/api';
import { toChunk, type AvailabilityChunk } from '@/lib/availability-source';

/**
 * One window of a public event's availability, for the booking island.
 *
 * The event page paints with the month on screen and reads the months after it
 * as the visitor gets near them (`useProgressiveSlots`). The island never holds
 * the API's base URL, which is server-only, so those reads come here and this
 * forwards them to the same public routes the page itself reads.
 *
 * It adds no reach: every parameter is one the public API already accepts from
 * anyone, the API clamps the window itself, and nothing is cached, so a hold or
 * a booking still re-checks its slot against the calendar at write time. It
 * refuses what the page would never ask, so a malformed request costs no
 * calendar read.
 */
const MAX_PARAM = 200;

function text(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  return v && v.length <= MAX_PARAM ? v : null;
}

function instant(params: URLSearchParams, key: string): number | null {
  const v = text(params, key);
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function json(body: AvailabilityChunk | { error: string }, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const kind = q.get('kind');
  const accountCode = text(q, 'accountCode');
  const owner = text(q, 'owner');
  const slug = text(q, 'slug');
  const fromMs = instant(q, 'from');
  const toMs = instant(q, 'to');
  if (
    (kind !== 'personal' && kind !== 'team') ||
    !accountCode ||
    !owner ||
    !slug ||
    fromMs === null ||
    toMs === null ||
    toMs <= fromMs ||
    toMs - fromMs > MAX_AVAILABILITY_WINDOW_MS
  ) {
    return json({ error: 'BAD_REQUEST' }, 400);
  }
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  try {
    const r =
      kind === 'team'
        ? await getTeamAvailability({ accountCode, teamSlug: owner, slug, from, to })
        : await getAvailability({ accountCode, handle: owner, slug, from, to });
    if (!r) return json({ error: 'NOT_FOUND' }, 404);
    return json(toChunk(r));
  } catch {
    // The API's own failure is not the visitor's business; the island treats
    // any non-200 as "this window did not answer" and asks again later.
    return json({ ok: false }, 502);
  }
}
