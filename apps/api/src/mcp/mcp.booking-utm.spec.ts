import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBookingUtm, sql } from '@slate/db';
import { bootHarness, errorText, structured, type Harness } from './mcp-harness';

/**
 * get_booking answers the campaign a booking came from, inside
 * `invitee_supplied` (anyone can type a `utm_*` on an address), cleaned like
 * the rest of it, and null when the booking has none. list_bookings stays
 * minimal and never carries it.
 */

type Got = { booking: { uid: string }; invitee_supplied: { utm: Record<string, string> | null } };

let h: Harness;
beforeAll(async () => {
  h = await bootHarness({ MCP_RATE_LIMIT_CAPACITY: '200' });
});
afterAll(async () => {
  await h.close();
});

describe('the campaign on get_booking', () => {
  it('returns the stored utm_* keys, and null on a booking without any', async () => {
    const withCampaign = await h.newBooking();
    await setBookingUtm(h.db, withCampaign, { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'q4 launch' });
    const without = await h.newBooking();
    const c = await h.connect(await h.key(['bookings:read']));

    const got = structured<Got>(await c.callTool({ name: 'get_booking', arguments: { booking_uid: withCampaign } }));
    expect(got.invitee_supplied.utm).toEqual({ utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'q4 launch' });

    const none = structured<Got>(await c.callTool({ name: 'get_booking', arguments: { booking_uid: without } }));
    expect(none.invitee_supplied.utm).toBeNull();

    // The list stays minimal: no campaign on a row.
    const list = structured<{ bookings: Record<string, unknown>[] }>(await c.callTool({ name: 'list_bookings', arguments: { limit: 50 } }));
    const row = list.bookings.find((b) => b['uid'] === withCampaign)!;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toMatch(/utm|newsletter/);
  });

  it('cleans a stored value like any other text an invitee could type', async () => {
    const uid = await h.newBooking();
    // Written straight to the row, past the booking write's own cleaning, as an
    // older or hand-edited row could hold it.
    await h.db.run(
      sql`UPDATE booking SET utm = ${JSON.stringify({ utm_source: 'ads <b>now</b> [here](http://evil.test)', utm_term: 'x' })} WHERE uid = ${uid}`,
    );
    const c = await h.connect(await h.key(['bookings:read']));
    const got = structured<Got>(await c.callTool({ name: 'get_booking', arguments: { booking_uid: uid } }));
    expect(got.invitee_supplied.utm!['utm_source']).toContain('ads');
    expect(got.invitee_supplied.utm!['utm_source']).not.toMatch(/<b>|http:\/\/evil/);
    expect(got.invitee_supplied.utm!['utm_term']).toBe('x');
  });

  it('says so in the catalog, and a key outside the booking still reads nothing', async () => {
    const c = await h.connect(await h.key(['bookings:read']));
    const { tools } = await c.listTools();
    const tool = tools.find((t) => t.name === 'get_booking')!;
    expect(tool.description).toContain('invitee_supplied.utm');
    const supplied = (tool.outputSchema as { properties: { invitee_supplied: { properties: Record<string, unknown> } } }).properties
      .invitee_supplied.properties;
    expect(Object.keys(supplied)).toContain('utm');

    const uid = await h.newBooking();
    await setBookingUtm(h.db, uid, { utm_source: 'google' });
    const narrow = await h.connect(await h.key(['bookings:read'], { eventTypeIds: [h.other.eventTypeId] }));
    expect(errorText(await narrow.callTool({ name: 'get_booking', arguments: { booking_uid: uid } }))).toContain('NOT_FOUND');
  });
});
