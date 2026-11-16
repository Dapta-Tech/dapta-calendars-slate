import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { errorText, idem, structured } from './mcp-harness';
import { addMember, signIn } from './mcp-signin';
import { bootOAuth, type OAuthHarness } from '../oauth/oauth-harness';

/**
 * A sign-in's token is verified offline, so the door asks on every call whether
 * the member behind it is still active. One check covers every tool.
 */

const SCOPES = 'event-types:read availability:read bookings:read bookings:write bookings:cancel';
let h: OAuthHarness;
let introId: string;

beforeAll(async () => {
  h = await bootOAuth();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

const start = new Date(Date.now() + 10 * 86_400_000).toISOString();

describe('the active-member check at the MCP door', () => {
  it('lets an active member work, then refuses writes and reads once they are disabled', async () => {
    const memberId = await addMember(h, 'admin');
    const c = await signIn(h, memberId, SCOPES);

    const uid = await h.newBooking();
    const cancelled = structured<{ booking: { status: string } }>(await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: uid } }));
    expect(cancelled.booking.status).toBe('cancelled');
    expect(structured<{ event_types: unknown[] }>(await c.callTool({ name: 'list_event_types', arguments: {} })).event_types.length).toBeGreaterThan(0);

    await h.db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${memberId}`);
    const target = await h.newBooking();
    const calls: [string, Record<string, unknown>][] = [
      ['cancel_booking', { booking_uid: target }],
      ['hold_slot', { event_type_id: introId, start, time_zone: 'UTC', idempotency_key: idem('door-hold-00001') }],
      [
        'create_booking',
        {
          event_type_id: introId,
          start,
          attendee: { name: 'Pat', email: 'pat@example.org', time_zone: 'UTC' },
          idempotency_key: idem('door-book-00001'),
        },
      ],
      ['list_event_types', {}],
    ];
    for (const [name, args] of calls) expect(errorText(await c.callTool({ name, arguments: args })), name).toContain('FORBIDDEN');
    // Nothing was cancelled by the refused call.
    const row = await h.db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${target}`);
    expect(row!.status).toBe('accepted');
  });

  it('refuses a sign-in whose member no longer exists in the account, and leaves API keys alone', async () => {
    const memberId = await addMember(h, 'admin');
    const c = await signIn(h, memberId, SCOPES);
    await h.db.run(sql`UPDATE member SET account_id = ${h.other.accountId} WHERE id = ${memberId}`);
    expect(errorText(await c.callTool({ name: 'list_event_types', arguments: {} }))).toContain('FORBIDDEN');

    const key = await h.connect(await h.key(['event-types:read']));
    expect(structured<{ event_types: unknown[] }>(await key.callTool({ name: 'list_event_types', arguments: {} })).event_types.length).toBeGreaterThan(0);
  });
});
