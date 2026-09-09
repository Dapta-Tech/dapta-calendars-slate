import { describe, it, expect } from 'vitest';
import {
  CrmAuthError,
  CrmPropertyError,
  DisabledCrmProvider,
  HUBSPOT_REQUIRED_SCOPES,
  HubSpotCrmProvider,
  resolveCrmProvider,
} from './index';

/**
 * Seam C — the adapter, against a stubbed fetch.
 *
 * Every assertion here traces to a fact #74 established against a live portal,
 * or to a rule #63 decided. In particular: the inline association is what makes
 * the single outbox row sufficient, and the structured 403 is what lets a UI
 * name the checkbox a host missed. Both are asserted on the WIRE, because a
 * refactor that quietly dropped either would still typecheck.
 */
interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
}

function stub(responses: { status: number; body?: unknown }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      authorization: headers.authorization,
    });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? null,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN = 'pat-test-token';

describe('required scopes', () => {
  // #74: contacts read+write ALONE create a meeting engagement. There is no
  // meetings scope to grant. H1b renders this exact list as its checklist, so
  // it lives here rather than being retyped into the dialog.
  it('is exactly the two contacts scopes', () => {
    expect([...HUBSPOT_REQUIRED_SCOPES]).toEqual([
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
    ]);
  });
});

describe('verifyCredential', () => {
  it('reads contact properties with the token as a bearer', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { results: [] } }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).verifyCredential({ token: TOKEN });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/crm/v3/properties/contacts');
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('throws a CrmAuthError carrying the scope LIST on 403', async () => {
    // The exact body shape #74 observed.
    const { fetchImpl } = stub([
      {
        status: 403,
        body: {
          category: 'MISSING_SCOPES',
          message: "This app hasn't been granted all required scopes to make this call.",
          errors: [
            { context: { requiredGranularScopes: ['crm.objects.contacts.write'] } },
            { context: { requiredGranularScopes: ['crm.objects.contacts.read'] } },
          ],
        },
      },
    ]);
    const err = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl)
      .verifyCredential({ token: TOKEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmAuthError);
    const auth = err as CrmAuthError;
    expect(auth.status).toBe(403);
    expect(auth.category).toBe('MISSING_SCOPES');
    expect(auth.requiredGranularScopes).toEqual([
      'crm.objects.contacts.write',
      'crm.objects.contacts.read',
    ]);
  });

  it('throws a CrmAuthError on 401 even when the body is unrecognizable', async () => {
    const { fetchImpl } = stub([{ status: 401 }]);
    const err = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl)
      .verifyCredential({ token: TOKEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmAuthError);
    // Still terminal, just with nothing actionable to show.
    expect((err as CrmAuthError).requiredGranularScopes).toEqual([]);
  });
});

describe('resolveContact', () => {
  it('takes the id of an existing contact and writes NO properties', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { results: [{ id: '247424370588' }] } }]);
    const out = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).resolveContact({
      token: TOKEN,
      email: 'lead@example.com',
      firstName: 'Typo',
      lastName: 'Name',
    });
    expect(out).toEqual({ contactId: '247424370588', created: false });
    // The rule #63 decided: a booking is not the source of truth on a lead's
    // identity, so exactly one call happens and it is the search.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/crm/v3/objects/contacts/search');
  });

  it('searches by email EQ, then creates when absent', async () => {
    const { fetchImpl, calls } = stub([
      { status: 200, body: { results: [] } },
      { status: 201, body: { id: '999' } },
    ]);
    const out = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).resolveContact({
      token: TOKEN,
      email: 'lead@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(out).toEqual({ contactId: '999', created: true });

    const search = calls[0]!.body as {
      filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
    };
    expect(search.filterGroups[0]!.filters[0]).toEqual({
      propertyName: 'email',
      operator: 'EQ',
      value: 'lead@example.com',
    });

    const create = calls[1]!.body as { properties: Record<string, string> };
    expect(calls[1]!.url).toContain('/crm/v3/objects/contacts');
    expect(create.properties).toEqual({
      email: 'lead@example.com',
      firstname: 'Ada',
      lastname: 'Lovelace',
    });
  });

  it('omits a missing name rather than writing a blank over it', async () => {
    const { fetchImpl, calls } = stub([
      { status: 200, body: { results: [] } },
      { status: 201, body: { id: '1' } },
    ]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).resolveContact({
      token: TOKEN,
      email: 'lead@example.com',
      firstName: 'Cher',
      lastName: null,
    });
    const create = calls[1]!.body as { properties: Record<string, string> };
    expect(create.properties).toEqual({ email: 'lead@example.com', firstname: 'Cher' });
    expect(create.properties).not.toHaveProperty('lastname');
  });
});

describe('createMeeting', () => {
  const input = {
    token: TOKEN,
    contactId: '247424370588',
    title: 'Intro call — Ada Lovelace',
    body: 'Host: Alex\nBudget: 50k',
    startUtc: '2026-10-01T15:00:00.000Z',
    endUtc: '2026-10-01T15:30:00.000Z',
  };

  /**
   * The single-outbox-row shape, asserted on the wire. If the association ever
   * left the create body, the contact and the meeting would need ordering the
   * outbox does not have.
   */
  it('associates the contact INLINE in the create call', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: '116619649203' } }]);
    const out = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).createMeeting(input);
    expect(out).toEqual({ meetingId: '116619649203' });
    expect(calls).toHaveLength(1);

    const body = calls[0]!.body as {
      associations: { to: { id: string }; types: Record<string, unknown>[] }[];
    };
    expect(body.associations).toEqual([
      {
        to: { id: '247424370588' },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }],
      },
    ]);
  });

  // #63: zero custom properties, which is what keeps the free tier's property
  // cap out of this ticket and inside #64.
  it('writes only stock hs_meeting_* properties', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: '1' } }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).createMeeting(input);
    const props = (calls[0]!.body as { properties: Record<string, string> }).properties;
    expect(Object.keys(props).sort()).toEqual([
      'hs_meeting_body',
      'hs_meeting_end_time',
      'hs_meeting_outcome',
      'hs_meeting_start_time',
      'hs_meeting_title',
      'hs_timestamp',
    ]);
    expect(props.hs_meeting_start_time).toBe(String(Date.parse(input.startUtc)));
    expect(props.hs_meeting_end_time).toBe(String(Date.parse(input.endUtc)));
    expect(props.hs_meeting_outcome).toBe('SCHEDULED');
  });

  // The manage link is deliberately absent: it carries a token that cancels and
  // reschedules the invitee's booking, and a shared CRM is the wrong audience.
  it('writes no external-url property, so no capability token reaches the CRM', async () => {
    const { fetchImpl, calls } = stub([{ status: 201, body: { id: '1' } }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).createMeeting(input);
    const props = (calls[0]!.body as { properties: Record<string, string> }).properties;
    expect(props).not.toHaveProperty('hs_meeting_external_url');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('token=');
  });

  it('surfaces an unknown property as a recoverable CrmPropertyError naming it', async () => {
    const { fetchImpl } = stub([
      {
        status: 400,
        body: { category: 'PROPERTY_DOESNT_EXIST', message: 'Property "hs_meeting_body" does not exist' },
      },
    ]);
    const err = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl)
      .createMeeting(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmPropertyError);
    expect((err as CrmPropertyError).propertyName).toBe('hs_meeting_body');
  });

  // 429 / 5xx take the outbox's backoff — a plain Error, not a terminal one.
  it('throws a plain retryable error on 429 and 5xx', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = stub([{ status, body: { category: 'RATE_LIMITS' } }]);
      const err = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl)
        .createMeeting(input)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CrmAuthError);
      expect(String(err)).toContain(String(status));
    }
  });

  /**
   * `last_error` is a durable column and an error body can echo the invitee
   * details we just sent. Status and category only.
   */
  it('never puts the vendor error body or the token into the thrown message', async () => {
    const { fetchImpl } = stub([
      { status: 500, body: { message: 'lead@example.com could not be processed' } },
    ]);
    const err = await new HubSpotCrmProvider(undefined, 10_000, fetchImpl)
      .createMeeting(input)
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain('lead@example.com');
    expect(String(err)).not.toContain(TOKEN);
  });
});

describe('updateMeeting', () => {
  it('PATCHes the same meeting id on cancel, with the outcome', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).updateMeeting({
      token: TOKEN,
      meetingId: '116619649203',
      title: '[Canceled] Intro call',
      outcome: 'canceled',
    });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/crm/v3/objects/meetings/116619649203');
    const props = (calls[0]!.body as { properties: Record<string, string> }).properties;
    expect(props.hs_meeting_outcome).toBe('CANCELED');
    expect(props.hs_meeting_title).toBe('[Canceled] Intro call');
  });

  it('moves the times on a reschedule without touching the title', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).updateMeeting({
      token: TOKEN,
      meetingId: '1',
      startUtc: '2026-10-02T15:00:00.000Z',
      endUtc: '2026-10-02T15:30:00.000Z',
      outcome: 'scheduled',
    });
    const props = (calls[0]!.body as { properties: Record<string, string> }).properties;
    expect(props.hs_meeting_start_time).toBe(String(Date.parse('2026-10-02T15:00:00.000Z')));
    // `hs_timestamp` follows the start so the engagement sorts where the
    // meeting actually is after the move.
    expect(props.hs_timestamp).toBe(props.hs_meeting_start_time);
    expect(props).not.toHaveProperty('hs_meeting_title');
  });

  it('makes no call at all when there is nothing to change', async () => {
    const { fetchImpl, calls } = stub([{ status: 200 }]);
    await new HubSpotCrmProvider(undefined, 10_000, fetchImpl).updateMeeting({
      token: TOKEN,
      meetingId: '1',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('provider selection', () => {
  // Clone-and-run: the OSS default enqueues nothing and calls nothing.
  it('defaults to disabled', () => {
    expect(resolveCrmProvider({}).enabled).toBe(false);
    expect(resolveCrmProvider({ CRM_PROVIDER: 'disabled' })).toBeInstanceOf(DisabledCrmProvider);
  });

  it('selects the HubSpot adapter when asked', () => {
    const p = resolveCrmProvider({ CRM_PROVIDER: 'hubspot' });
    expect(p.enabled).toBe(true);
    expect(p.name).toBe('hubspot');
  });

  // Reaching a disabled provider's method means something bypassed `enabled`.
  it('the disabled provider throws rather than silently succeeding', async () => {
    await expect(new DisabledCrmProvider().verifyCredential()).rejects.toThrow(/CRM_PROVIDER/);
  });
});
