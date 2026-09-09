/**
 * The HubSpot adapter for the `CrmProvider` port.
 *
 * Vendor-named on purpose — see ADR 0001, and `port.ts`'s header. R15 governs
 * calendar vendors only.
 *
 * Everything here rests on facts verified against a LIVE portal in #74, not on
 * documentation that was ambiguous:
 *
 *  - `crm.objects.contacts.read` + `crm.objects.contacts.write` ALONE create a
 *    meeting engagement (201). There is no meetings scope to grant, and none is
 *    needed — so the connect checklist is exactly two checkboxes.
 *  - The inline association (`associationTypeId: 200`, `HUBSPOT_DEFINED`) lands
 *    in the SAME create call. `GET /objects/meetings/{id}/associations/contacts`
 *    returns `meeting_event_to_contact`. That is what makes one outbox row
 *    sufficient: no second association call exists to order.
 *  - A 403 carries `category: "MISSING_SCOPES"` and
 *    `errors[].context.requiredGranularScopes` — a scope NAME LIST.
 *  - The newer `appointments` object family is closed to private apps entirely
 *    ("isn't available for public use"), so meeting engagements are not merely
 *    the chosen target, they are the only reachable one.
 *
 * This adapter creates ZERO custom properties. Only stock `hs_meeting_*` fields
 * are written, which is what keeps the free tier's ~10-property cap out of this
 * ticket and inside #64.
 */
import {
  CrmAuthError,
  CrmPropertyError,
  type CrmContactInput,
  type CrmContactResult,
  type CrmMeetingInput,
  type CrmMeetingUpdate,
  type CrmProvider,
} from './port';

/** The vendor's public API host. Public by nature; passes the publish gate. */
export const HUBSPOT_API_BASE_URL = 'https://api.hubapi.com';

/**
 * The two scopes a private app needs, verified in #74. Exported because H1b's
 * connect dialog renders this list as its checklist — one source, so the
 * instructions cannot drift from what the adapter actually requires.
 */
export const HUBSPOT_REQUIRED_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
] as const;

/** Contact ↔ meeting, `HUBSPOT_DEFINED`. Verified inline-on-create in #74. */
const MEETING_TO_CONTACT_ASSOCIATION_TYPE_ID = 200;

interface HubSpotErrorBody {
  category?: string;
  message?: string;
  errors?: { message?: string; context?: { requiredGranularScopes?: string[] } }[];
}

export class HubSpotCrmProvider implements CrmProvider {
  readonly enabled = true;
  readonly name = 'hubspot';
  /** The port's checklist source (#93) — the same list this adapter needs. */
  readonly requiredScopes: readonly string[] = HUBSPOT_REQUIRED_SCOPES;

  constructor(
    private readonly baseUrl: string = HUBSPOT_API_BASE_URL,
    private readonly timeoutMs = 10_000,
    /** Injectable for tests; defaults to global fetch (mirrors DaptaSyncEffects). */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Validate by use. #63 rejected the token-introspection endpoint that would
   * have returned the full scope list: it is documented only in community
   * threads and has an EU-token quirk, and resting the connect gate on an
   * undocumented endpoint is fragile. A plain read of the contacts properties
   * is documented and cheap.
   *
   * What it proves: the token is real, live, and carries
   * `crm.objects.contacts.read`. What it does NOT prove: the write scope. A
   * probe for that would have to CREATE something in the customer's portal, and
   * leaving debris in a CRM to check a checkbox is a worse trade than the
   * residual — a read-only token connects cleanly and then fails on its first
   * booking, where the 403 marks the integration unhealthy and names
   * `crm.objects.contacts.write` as the missing scope. Wrong-but-recoverable,
   * and visible, beats writing junk into a customer's records.
   */
  async verifyCredential({ token }: { token: string }): Promise<void> {
    await this.request(token, 'GET', '/crm/v3/properties/contacts');
  }

  async resolveContact(input: CrmContactInput): Promise<CrmContactResult> {
    const found = await this.request<{ results?: { id?: string }[] }>(
      input.token,
      'POST',
      '/crm/v3/objects/contacts/search',
      {
        filterGroups: [
          { filters: [{ propertyName: 'email', operator: 'EQ', value: input.email }] },
        ],
        properties: ['email'],
        limit: 1,
      },
    );
    const existingId = found?.results?.[0]?.id;
    // A contact the CRM already knows keeps its own name. We take the id and
    // write NOTHING — #63's central identity rule.
    if (existingId) return { contactId: String(existingId), created: false };

    const created = await this.request<{ id?: string }>(
      input.token,
      'POST',
      '/crm/v3/objects/contacts',
      {
        properties: pruneEmpty({
          email: input.email,
          firstname: input.firstName,
          lastname: input.lastName,
        }),
      },
    );
    if (!created?.id) throw new Error('hubspot contact create returned no id');
    return { contactId: String(created.id), created: true };
  }

  /**
   * ONE call: the meeting and its association to the contact. `hs_timestamp` is
   * required by the engagements model and is set to the meeting's start.
   */
  async createMeeting(input: CrmMeetingInput): Promise<{ meetingId: string }> {
    const start = Date.parse(input.startUtc);
    const res = await this.request<{ id?: string }>(input.token, 'POST', '/crm/v3/objects/meetings', {
      properties: pruneEmpty({
        hs_timestamp: String(start),
        hs_meeting_title: input.title,
        hs_meeting_body: input.body,
        hs_meeting_start_time: String(start),
        hs_meeting_end_time: String(Date.parse(input.endUtc)),
        hs_meeting_outcome: 'SCHEDULED',
      }),
      associations: [
        {
          to: { id: input.contactId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: MEETING_TO_CONTACT_ASSOCIATION_TYPE_ID,
            },
          ],
        },
      ],
    });
    if (!res?.id) throw new Error('hubspot meeting create returned no id');
    return { meetingId: String(res.id) };
  }

  /** PATCH the SAME meeting. Cancel and reschedule never mint a second one. */
  async updateMeeting(input: CrmMeetingUpdate): Promise<void> {
    const properties = pruneEmpty({
      hs_meeting_title: input.title ?? null,
      hs_meeting_body: input.body ?? null,
      hs_meeting_start_time: input.startUtc ? String(Date.parse(input.startUtc)) : null,
      hs_meeting_end_time: input.endUtc ? String(Date.parse(input.endUtc)) : null,
      // `hs_timestamp` follows the start so the engagement sorts on the
      // timeline where the meeting actually is after a reschedule.
      hs_timestamp: input.startUtc ? String(Date.parse(input.startUtc)) : null,
      hs_meeting_outcome: input.outcome ? input.outcome.toUpperCase() : null,
    });
    if (Object.keys(properties).length === 0) return;
    await this.request(
      input.token,
      'PATCH',
      `/crm/v3/objects/meetings/${encodeURIComponent(input.meetingId)}`,
      { properties },
    );
  }

  /**
   * One bounded request, with the error classification the outbox's retry
   * decision depends on. Nothing here logs or echoes the token.
   */
  private async request<T = unknown>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.ok) return (await res.json().catch(() => null)) as T | null;

    const parsed = (await res.json().catch(() => null)) as HubSpotErrorBody | null;

    // Terminal: a credential problem cannot be retried into success.
    if (res.status === 401 || res.status === 403) {
      const scopes = [
        ...new Set((parsed?.errors ?? []).flatMap((e) => e.context?.requiredGranularScopes ?? [])),
      ];
      throw new CrmAuthError(
        // The vendor's own message, which for MISSING_SCOPES is generic — the
        // scope LIST above is the part that is actually actionable.
        parsed?.message ?? `hubspot ${method} ${path} → ${res.status}`,
        res.status,
        parsed?.category ?? null,
        scopes,
      );
    }

    // Recoverable once: drop the property the CRM says it does not have.
    if (res.status === 400 && parsed?.category === 'PROPERTY_DOESNT_EXIST') {
      throw new CrmPropertyError(
        parsed.message ?? 'hubspot rejected an unknown property',
        extractPropertyName(parsed.message),
      );
    }

    // Everything else (429, 5xx, transport) takes the outbox's backoff. The
    // vendor does not document Retry-After on these, so backoff is defensive
    // regardless. Status and category only: an error body can echo the invitee
    // details we just sent, and `last_error` is a durable column.
    throw new Error(
      `hubspot ${method} ${path} → ${res.status}${parsed?.category ? ` (${parsed.category})` : ''}`,
    );
  }
}

/** `Property "budget" does not exist` → `budget`. Null when it cannot be read. */
function extractPropertyName(message: string | undefined): string | null {
  if (!message) return null;
  return /["'`]([A-Za-z0-9_]+)["'`]/.exec(message)?.[1] ?? null;
}

/** Drop null/empty values so we never write a blank over a real CRM value. */
function pruneEmpty(o: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}
