/**
 * Server-side API client. The web app talks to the Slate API over HTTP (never
 * imports @slate/db or the engine directly) so the deployment stays decoupled.
 */
import type { AvailabilityResponse, BookingView, PublicProfile } from '@slate/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function getProfile(accountCode: string, handle: string): Promise<PublicProfile | null> {
  return getJson<PublicProfile>(
    `/v1/profiles/${encodeURIComponent(accountCode)}/${encodeURIComponent(handle)}`,
  );
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
  booking?: BookingView;
  error?: string;
  message?: string;
}

export function getManageView(uid: string, token: string): Promise<BookingView | null> {
  return getJson<BookingView>(`/v1/bookings/${encodeURIComponent(uid)}?token=${encodeURIComponent(token)}`);
}

export async function postManage(
  uid: string,
  token: string,
  action: 'cancel' | 'reschedule',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(
    `${API_URL}/v1/bookings/${encodeURIComponent(uid)}/${action}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
  );
  if (res.ok) return { ok: true };
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, message: j.message ?? 'Something went wrong.' };
}

export async function postBooking(body: unknown): Promise<BookResult> {
  const res = await fetch(`${API_URL}/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 201) return { ok: true, booking: json as unknown as BookingView };
  return {
    ok: false,
    error: (json.error as string) ?? 'ERROR',
    message: (json.message as string) ?? 'Something went wrong.',
  };
}
