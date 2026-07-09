/**
 * Server-side admin API client. The dashboard runs against the host identity
 * (dev: the API's local-stub resolves the seeded account/member; prod: WorkOS).
 * All calls are no-store so the dashboard always reflects live data.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** An API error that carries the HTTP status + error code so callers can drive
 *  status-specific UX (409 slot-taken, 410 gone, 400 validation, …). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    // Surface the HTTP status (was discarded) so the UI can handle 409/410/400.
    throw new ApiError(res.status, j.message ?? j.error ?? `${method} ${path} → ${res.status}`, j.error);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => ({}))) as T;
}

export interface Me {
  accountId: string;
  accountCode: string;
  memberId: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  timeZone: string | null;
  locale: string | null;
}
export const adminApi = {
  me: () => req<Me>('GET', '/v1/me'),
  handleAvailable: (handle: string) =>
    req<{ handle: string; available: boolean; reason: string | null }>(
      'GET',
      `/v1/handle-available?handle=${encodeURIComponent(handle)}`,
    ),

  // Event types
  listEventTypes: () => req<EventType[]>('GET', '/v1/event-types'),
  getEventType: (id: string) => req<EventType>('GET', `/v1/event-types/${id}`),
  createEventType: (b: unknown) => req<EventType>('POST', '/v1/event-types', b),
  updateEventType: (id: string, b: unknown) => req<EventType>('PATCH', `/v1/event-types/${id}`, b),
  deleteEventType: (id: string) => req<void>('DELETE', `/v1/event-types/${id}`),

  // Schedules
  listSchedules: () => req<{ id: string; name: string; timeZone: string }[]>('GET', '/v1/schedules'),
  getSchedule: (id: string) => req<Schedule>('GET', `/v1/schedules/${id}`),
  createSchedule: (b: unknown) => req<Schedule>('POST', '/v1/schedules', b),
  updateSchedule: (id: string, b: unknown) => req<Schedule>('PATCH', `/v1/schedules/${id}`, b),

  // Teams
  listTeams: () => req<Team[]>('GET', '/v1/teams'),
  createTeam: (b: unknown) => req<Team>('POST', '/v1/teams', b),
  updateTeam: (id: string, b: unknown) => req<Team>('PATCH', `/v1/teams/${id}`, b),
  deleteTeam: (id: string) => req<{ id: string }>('DELETE', `/v1/teams/${id}`),
  teamMembers: (id: string) =>
    req<{ member_id: string; role: string; display_name: string | null; email: string | null }[]>(
      'GET',
      `/v1/teams/${id}/members`,
    ),
  addTeamMember: (id: string, b: unknown) => req('POST', `/v1/teams/${id}/members`, b),
  updateTeamMemberRole: (id: string, memberId: string, role: 'owner' | 'member') =>
    req('PATCH', `/v1/teams/${id}/members/${memberId}`, { role }),
  removeTeamMember: (id: string, memberId: string) =>
    req<void>('DELETE', `/v1/teams/${id}/members/${memberId}`),
  teamEventTypes: (id: string) => req<EventType[]>('GET', `/v1/teams/${id}/event-types`),

  // Members
  listMembers: () =>
    req<{ id: string; handle: string | null; display_name: string | null; email: string | null }[]>(
      'GET',
      '/v1/members',
    ),

  // Bookings (host)
  listBookings: (q = '') =>
    req<{ items: BookingItem[] }>('GET', `/v1/host/bookings${q ? `?${q}` : ''}`),

  // Connections
  listConnections: () => req<Connection[]>('GET', '/v1/connections'),
  createConnection: (b: unknown) => req('POST', '/v1/connections', b),
  connectionToken: () =>
    req<{ enabled: boolean; token: string | null; message: string }>('POST', '/v1/connections/token', {}),
  updateConnection: (id: string, b: unknown) => req('PATCH', `/v1/connections/${id}`, b),
  pingConnection: (id: string) =>
    req<{ ok: boolean; enabled: boolean; message: string }>('POST', `/v1/connections/${id}/ping`, {}),
  deleteConnection: (id: string) => req<void>('DELETE', `/v1/connections/${id}`),

  // API keys
  listApiKeys: () => req<ApiKeyRow[]>('GET', '/v1/api-keys'),
  createApiKey: (b: unknown) => req<{ plaintext: string; prefix: string }>('POST', '/v1/api-keys', b),
  revokeApiKey: (id: string) => req<void>('DELETE', `/v1/api-keys/${id}`),

  // Webhooks
  listWebhooks: () => req<WebhookRow[]>('GET', '/v1/webhooks'),
  createWebhook: (b: unknown) => req('POST', '/v1/webhooks', b),
  updateWebhook: (id: string, active: boolean) => req('PATCH', `/v1/webhooks/${id}`, { active }),
  pingWebhook: (id: string) =>
    req<{ ok: boolean; status?: number; message?: string }>('POST', `/v1/webhooks/${id}/ping`, {}),
  deleteWebhook: (id: string) => req<void>('DELETE', `/v1/webhooks/${id}`),

  // Branding
  profile: (code: string, handle: string) => req<Profile>('GET', `/v1/profiles/${code}/${handle}`),
  updateBranding: (b: unknown) => req('PATCH', '/v1/booking-page', b),
};

export interface EventType {
  id: string;
  memberId: string | null;
  teamId: string | null;
  slug: string;
  title: string;
  description: string | null;
  lengthMinutes: number;
  hidden: boolean;
  schedulingType: string | null;
  requiresConfirmation: boolean;
  seatsPerTimeSlot: number | null;
  bookingFields: unknown[];
  hostMemberIds: string[];
}
export interface Schedule {
  id: string;
  memberId: string;
  name: string;
  timeZone: string;
  rules: Array<{ id: string; days: number[] | null; startTime: string; endTime: string; date: string | null }>;
}
export interface Team {
  id: string;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  timeZone: string;
  hideBranding: boolean;
}
export interface BookingItem {
  uid: string;
  status: string;
  title: string;
  startUtc: string;
  endUtc: string;
  hostMemberId: string | null;
}
export interface Connection {
  id: string;
  provider: string;
  externalId: string;
  primaryEmail: string | null;
  isDestination: boolean;
  checkConflicts: boolean;
}
export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  revoked_at_ms: number | null;
}
export interface WebhookRow {
  id: string;
  subscriber_url: string;
  event_triggers: unknown;
  active: number;
}
export interface Profile {
  account: { code: string; name: string };
  member: {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    brandColor: string | null;
    style: Record<string, unknown> | null;
  };
  eventTypes: Array<{ slug: string; title: string; lengthMinutes: number }>;
}
