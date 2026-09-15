/**
 * Server-side API client. The web app talks to the Slate API over HTTP (never
 * imports @slate/db or the engine directly) so the deployment stays decoupled.
 */
import { cache } from 'react';
import { bookingViewSchema, oneOffLinkTargetSchema } from '@slate/types';
import type {
  AvailabilityResponse,
  BookingView,
  OneOffLinkTargetView,
  PublicProfile,
} from '@slate/types';

// SERVER-side API base. MUST read the runtime env var `API_URL` — NOT
// `NEXT_PUBLIC_API_URL`, which Next INLINES at BUILD time (baked into the image,
// so a single image can't point at the right env). Falls back to NEXT_PUBLIC_*
// then localhost for a bare clone. Set `API_URL` in each deployment's config.
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * `oneOffToken` is optional and changes nothing when absent (#110). Present, it
 * rides as a header so the API can answer for the ONE hidden event that token
 * opens — see `ONE_OFF_HEADER` at the foot of this file for why a header and
 * not a query parameter.
 */
async function getJson<T>(path: string, oneOffToken?: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: 'no-store',
    headers: oneOffHeaders(oneOffToken),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

// cache(): generateMetadata and the page share one profile fetch per request.
export const getProfile = cache(
  (accountCode: string, handle: string): Promise<PublicProfile | null> =>
    getJson<PublicProfile>(
      `/v1/profiles/${encodeURIComponent(accountCode)}/${encodeURIComponent(handle)}`,
    ),
);

export interface TeamProfile {
  account: { code: string; name: string };
  team: { slug: string; name: string; logoUrl: string | null; timeZone: string };
  eventTypes: Array<{ slug: string; title: string; description: string | null; lengthMinutes: number }>;
}

// cache(): generateMetadata and the page share one team-profile fetch per request.
export const getTeamProfile = cache(
  (accountCode: string, teamSlug: string): Promise<TeamProfile | null> =>
    getJson<TeamProfile>(
      `/v1/public/teams/${encodeURIComponent(accountCode)}/${encodeURIComponent(teamSlug)}`,
    ),
);

export function getTeamAvailability(params: {
  accountCode: string;
  teamSlug: string;
  slug: string;
  from: string;
  to: string;
}): Promise<AvailabilityResponse | null> {
  const qs = new URLSearchParams({ slug: params.slug, from: params.from, to: params.to });
  return getJson<AvailabilityResponse>(
    `/v1/public/teams/${encodeURIComponent(params.accountCode)}/${encodeURIComponent(params.teamSlug)}/availability?${qs}`,
  );
}

/**
 * Read a booking body as a `BookingView` — PARSED against the shared contract,
 * not asserted into it. The team route used to answer a narrow
 * `{ uid, hostMemberId, manageUrl }`, and an `as unknown as BookingView` cast
 * called that a booking, so `startUtc` reached the confirmation `undefined`
 * and the render threw into the public error boundary (#102).
 *
 * A body that fails to parse is still a real booking — a 201 is the API saying
 * the row exists, and the manage read is a booking the visitor already made —
 * so this never turns one into a failure: reporting failure for a booking that
 * succeeded is exactly what sends a booker back to make a second one. It hands
 * over what arrived and lets the page render the fields it actually has, which
 * is why every caller's render must tolerate a missing field (#123).
 *
 * `source` names the path that drifted, so the log line below points at one of
 * the three rather than at "a booking somewhere".
 */
function toBookingView(json: Record<string, unknown>, source: string): BookingView {
  const parsed = bookingViewSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  // Say so. #102 hid for as long as it did because the cast absorbed the
  // mismatch silently and it only ever surfaced as a `RangeError` thrown deep
  // in a render. This runs server-side, so the line lands in the app log. It
  // names the FIELD PATHS only — never the body, which carries the attendee's
  // name and email.
  console.warn(
    `[web] ${source} response did not match the booking contract: ${parsed.error.issues
      .map((i) => i.path.join('.') || '(root)')
      .join(', ')}`,
  );
  return json as Partial<BookingView> as BookingView;
}

export async function postTeamBooking(
  accountCode: string,
  teamSlug: string,
  body: unknown,
  oneOffToken?: string,
): Promise<BookResult> {
  const res = await fetch(
    `${API_URL}/v1/public/teams/${encodeURIComponent(accountCode)}/${encodeURIComponent(teamSlug)}/bookings`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...oneOffHeaders(oneOffToken) },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 201) return { ok: true, status: 201, booking: toBookingView(json, 'team booking') };
  return { ok: false, status: res.status, error: (json.error as string) ?? 'ERROR', message: (json.message as string) ?? 'Failed' };
}

/**
 * Slots ONE booking can be moved to, token-gated (#127).
 *
 * The manage page's picker asks this for a TEAM booking rather than the public
 * team availability route. That route answers what the event offers a NEW
 * invitee, and for a round-robin team event that is the UNION across hosts —
 * any host free is enough, because create time still gets to choose who takes
 * it. A reschedule does not choose again: the booking keeps the host set it was
 * assigned, so the union listed times the reschedule then refused with a 400.
 * This asks the narrower question the write actually answers.
 */
export async function getRescheduleAvailability(params: {
  uid: string;
  token: string;
  from: string;
  to: string;
  timeZone?: string;
}): Promise<AvailabilityResponse | null> {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.timeZone) qs.set('timeZone', params.timeZone);
  // The manage token travels in the HEADER, not `?token=`. The query form is
  // supported for links already in the wild (emails, calendar invites); this is
  // a new server-to-server call, so it can keep the token out of access logs
  // and Referer from the start.
  const res = await fetch(
    `${API_URL}/v1/bookings/${encodeURIComponent(params.uid)}/availability?${qs.toString()}`,
    { headers: { 'x-manage-token': params.token }, cache: 'no-store' },
  );
  // 404 = no such booking, or a manage link that no longer opens one. Both mean
  // "no times to offer" and the page renders its empty picker, exactly as it
  // does for an event with nothing free.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API reschedule availability failed: ${res.status}`);
  return (await res.json()) as AvailabilityResponse;
}

export function getAvailability(params: {
  accountCode: string;
  handle: string;
  slug: string;
  from: string;
  to: string;
  timeZone?: string;
}): Promise<AvailabilityResponse | null> {
  const qs = new URLSearchParams({
    accountCode: params.accountCode,
    handle: params.handle,
    slug: params.slug,
    from: params.from,
    to: params.to,
  });
  if (params.timeZone) qs.set('timeZone', params.timeZone);
  return getJson<AvailabilityResponse>(`/v1/availability?${qs.toString()}`);
}

export interface BookResult {
  ok: boolean;
  /** The HTTP status — surfaced so the UI can handle 409 (taken) / 410 (expired). */
  status: number;
  booking?: BookingView;
  error?: string;
  message?: string;
}

export interface ReserveResult {
  ok: boolean;
  status: number;
  reservationUid?: string;
  expiresAt?: string;
  message?: string;
}

/** Create a soft hold on a slot (public reserve→confirm two-step). */
export async function postReservation(
  body: {
    accountCode: string;
    handle: string;
    slug: string;
    startUtc: string;
  },
  oneOffToken?: string,
): Promise<ReserveResult> {
  const res = await fetch(`${API_URL}/v1/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...oneOffHeaders(oneOffToken) },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 201)
    return {
      ok: true,
      status: 201,
      reservationUid: json.reservationUid as string,
      expiresAt: json.expiresAt as string,
    };
  return { ok: false, status: res.status, message: (json.message as string) ?? 'Could not hold the time.' };
}

/**
 * Give a soft hold back (#135) — the counterpart to `postReservation`.
 *
 * Best-effort and silent: it resolves whatever happens. The booker is already
 * on their way back to the times when this fires, there is nothing they could
 * do about a failure, and the ten-minute TTL is the backstop that made the hold
 * safe before any release existed. The API answers the same 200 for a uid that
 * names nothing, so there is no outcome worth branching on.
 */
export async function postReservationRelease(reservationUid: string): Promise<void> {
  try {
    await fetch(`${API_URL}/v1/reservations/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservationUid }),
      cache: 'no-store',
    });
  } catch {
    // Swallowed on purpose — see above.
  }
}

/**
 * The manage read has three outcomes and the page renders something different
 * for each, so it answers a result rather than `BookingView | null` (#123).
 *
 * `invalid-link` is the one worth naming. The manage token ROTATES on every
 * reschedule (the single-active-token invariant), so the link in an older
 * confirmation or reschedule email answers 403 BY DESIGN. That is a routine
 * event on a page whose only entry point is an emailed link — and it used to
 * throw out of `getJson`, telling someone whose booking is perfectly fine that
 * something had failed.
 */
export type ManageViewResult =
  | { ok: true; booking: BookingView }
  | { ok: false; reason: 'not-found' | 'invalid-link' };

/**
 * Read the token-gated manage view — PARSED with the same `bookingViewSchema`
 * the two booking POST paths use, not asserted through `getJson<BookingView>`
 * (#123). This route is reached from a link in a CONFIRMATION EMAIL, so a shape
 * drift here is hit by someone who has already booked and is trying to cancel
 * or reschedule; the unchecked cast would surface it as a `RangeError` thrown
 * from a render and a public error boundary — #102's failure mode, one endpoint
 * over.
 *
 * A body that fails to PARSE is still handed over (see `toBookingView`) because
 * it still describes a real booking; only the REQUEST outcomes branch here.
 */
export async function getManageView(uid: string, token: string): Promise<ManageViewResult> {
  const res = await fetch(
    `${API_URL}/v1/bookings/${encodeURIComponent(uid)}?token=${encodeURIComponent(token)}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  // 403 = a wrong or already-rotated token; 410 = the booking is gone. Both are
  // a dead LINK rather than a failure, and both have to read as one.
  if (res.status === 403 || res.status === 410) return { ok: false, reason: 'invalid-link' };
  if (!res.ok) throw new Error(`API manage view failed: ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: true, booking: toBookingView(json, 'manage view') };
}

export async function postManage(
  uid: string,
  token: string,
  action: 'cancel' | 'reschedule',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; manageUrl?: string }> {
  const res = await fetch(
    `${API_URL}/v1/bookings/${encodeURIComponent(uid)}/${action}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
  );
  if (res.ok) {
    // A real reschedule ROTATES the manage token (single-active-token invariant),
    // so the token just used is now dead. Surface the fresh manageUrl so the
    // client can adopt the new token for any further cancel/reschedule.
    const j = (await res.json().catch(() => ({}))) as { manageUrl?: string };
    return { ok: true, manageUrl: j.manageUrl };
  }
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, message: j.message ?? 'Something went wrong.' };
}

export async function postBooking(body: unknown, oneOffToken?: string): Promise<BookResult> {
  const res = await fetch(`${API_URL}/v1/bookings`, {
    method: 'POST',
    // The token is a HEADER, never part of `body` — it is a credential, and the
    // body is re-validated against `createBookingSchema`, which would drop it.
    headers: { 'content-type': 'application/json', ...oneOffHeaders(oneOffToken) },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 201) return { ok: true, status: 201, booking: toBookingView(json, 'booking') };
  return {
    ok: false,
    status: res.status,
    error: (json.error as string) ?? 'ERROR',
    message: (json.message as string) ?? 'Something went wrong.',
  };
}

// --- One-off links (#69 / AB2, #110) ---------------------------------------

/**
 * The header the one-off token travels in, server-to-server.
 *
 * Mirrors `ONE_OFF_HEADER` in `apps/api/src/public.controller.ts`. A header
 * rather than a query parameter, for the same reason `getRescheduleAvailability`
 * above prefers `x-manage-token`: a token in a query string lands in access
 * logs and in `Referer` on every outbound click, and this one is a grant to
 * create a booking.
 *
 * Every call here runs on the SERVER — these functions read `API_URL`, which is
 * deliberately not a `NEXT_PUBLIC_*` value. The token therefore never becomes
 * part of a browser-issued request, so it is never exposed to a page's network
 * tab or to a third-party script on the booking page.
 */
const ONE_OFF_HEADER = 'x-one-off-token';

function oneOffHeaders(token: string | undefined): Record<string, string> {
  return token ? { [ONE_OFF_HEADER]: token } : {};
}

/**
 * What `/booking/{token}` learns about the token in its path.
 *
 * Three outcomes and the route renders a different thing for each, so this
 * answers a result rather than `target | null` — the same reasoning
 * `ManageViewResult` gives one function up. `gone` is the one worth naming: it
 * is the ORDINARY end of a one-off link's life, reached by the person the host
 * sent it to opening it a second time, and it must read as "this was used",
 * never as an error.
 */
export type OneOffLinkResult =
  | { ok: true; target: OneOffLinkTargetView }
  | { ok: false; reason: 'gone' | 'not-found' };

export async function getOneOffLink(token: string): Promise<OneOffLinkResult> {
  const res = await fetch(`${API_URL}/v1/public/one-off/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });
  if (res.status === 410) return { ok: false, reason: 'gone' };
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (!res.ok) throw new Error(`API one-off link failed: ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as unknown;
  // PARSED against the shared contract, never asserted into it — a drift here
  // would otherwise surface as a `RangeError` thrown from a render, which is
  // the failure #102 spent a release chasing on the booking routes.
  const parsed = oneOffLinkTargetSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(
      `[web] one-off link response did not match the contract: ${parsed.error.issues
        .map((i) => i.path.join('.') || '(root)')
        .join(', ')}`,
    );
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, target: parsed.data };
}

/**
 * Availability for the event a one-off link opens.
 *
 * A separate function from `getAvailability` only because it carries the
 * header; the route, the query and the response contract are identical. That is
 * the point of the design — a one-off booking page is the ordinary booking page
 * reading the ordinary endpoints, with one header that makes the hidden event
 * it points at visible to this request alone.
 */
export function getAvailabilityWithOneOff(params: {
  accountCode: string;
  handle: string;
  slug: string;
  from: string;
  to: string;
  timeZone?: string;
  oneOffToken: string;
}): Promise<AvailabilityResponse | null> {
  const qs = new URLSearchParams({
    accountCode: params.accountCode,
    handle: params.handle,
    slug: params.slug,
    from: params.from,
    to: params.to,
  });
  if (params.timeZone) qs.set('timeZone', params.timeZone);
  return getJson<AvailabilityResponse>(`/v1/availability?${qs.toString()}`, params.oneOffToken);
}

/** The team mirror of `getAvailabilityWithOneOff`. */
export function getTeamAvailabilityWithOneOff(params: {
  accountCode: string;
  teamSlug: string;
  slug: string;
  from: string;
  to: string;
  oneOffToken: string;
}): Promise<AvailabilityResponse | null> {
  const qs = new URLSearchParams({ slug: params.slug, from: params.from, to: params.to });
  return getJson<AvailabilityResponse>(
    `/v1/public/teams/${encodeURIComponent(params.accountCode)}/${encodeURIComponent(params.teamSlug)}/availability?${qs}`,
    params.oneOffToken,
  );
}
