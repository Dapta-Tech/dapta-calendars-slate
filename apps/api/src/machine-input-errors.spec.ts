import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, type Harness } from './mcp/mcp-harness';

/**
 * The machine surface answers a request the booking engine refuses as input
 * with a 400 that names the field, as the public routes do. Before, the
 * engine's `ZodError` escaped as a 500: an agent sending a bad attendee email
 * got "Internal server error" and nothing to correct.
 */
describe('machine routes: invalid input is a 400 naming the field', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('POST /v1/machine/bookings with a bad attendee email', async () => {
    const key = await h.key(['bookings:write']);
    const res = await fetch(`${h.base}/v1/machine/bookings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: '2030-01-07T15:00:00.000Z',
        attendees: [{ name: 'Sam Doe', email: 'not-an-email', timeZone: 'UTC' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toBe('attendees[0].email: Invalid email');
  });

  it('PATCH /v1/machine/bookings/:uid names the Idempotency-Key header when it is too long', async () => {
    const key = await h.key(['bookings:write']);
    const uid = await h.newBooking();
    const res = await fetch(`${h.base}/v1/machine/bookings/${uid}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'k'.repeat(201) },
      body: JSON.stringify({ newStartUtc: '2030-01-08T15:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toMatch(/^Idempotency-Key: /);
  });

  it('GET /v1/machine/availability with a malformed window', async () => {
    const key = await h.key(['availability:read']);
    const res = await fetch(
      `${h.base}/v1/machine/availability?handle=alex-rivera&slug=intro-call&from=tomorrow&to=2030-01-08T00:00:00.000Z`,
      { headers: { authorization: `Bearer ${key}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toMatch(/^from: /);
  });

  async function cancel(uid: string, idempotencyKey: string) {
    const key = await h.key(['bookings:write']);
    return fetch(`${h.base}/v1/machine/bookings/${uid}/cancel`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({}),
    });
  }

  async function bookingStatus(uid: string): Promise<string | undefined> {
    const row = await h.db.get<{ status: string }>(
      sql`SELECT status FROM booking WHERE uid = ${uid}`,
    );
    return row?.status;
  }

  it('POST /v1/machine/bookings/:uid/cancel names the Idempotency-Key header when it is too long', async () => {
    const uid = await h.newBooking();
    const res = await cancel(uid, 'k'.repeat(201));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toMatch(/^Idempotency-Key: /);
    expect(await bookingStatus(uid)).toBe('accepted');
  });

  it('POST /v1/machine/bookings/:uid/cancel still cancels with a valid Idempotency-Key', async () => {
    const uid = await h.newBooking();
    const res = await cancel(uid, 'cancel-once');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid, status: 'cancelled' });
    expect(await bookingStatus(uid)).toBe('cancelled');
  });

  async function list(query: string) {
    const key = await h.key(['bookings:read']);
    return fetch(`${h.base}/v1/machine/bookings?${query}`, {
      headers: { authorization: `Bearer ${key}` },
    });
  }

  it.each([
    ['from=tomorrow', 'from: Invalid date'],
    ['to=next-week', 'to: Invalid date'],
    ['limit=abc', 'limit: Expected an integer'],
    ['limit=10.5', 'limit: Expected an integer'],
    ['limit=1&limit=2', 'limit: Expected string, received array'],
  ])('GET /v1/machine/bookings?%s is a 400 naming the field', async (query, message) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'BAD_REQUEST', message });
  });

  it('GET /v1/machine/bookings keeps accepting any date the server can read and clamping the limit', async () => {
    const uid = await h.newBooking();
    const res = await list('from=2000-01-01&to=2100-01-01T00:00:00Z&limit=999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ uid: string }>; nextCursor: string | null };
    expect(body.items.length).toBeLessThanOrEqual(200);
    expect(body.items.map((item) => item.uid)).toContain(uid);
  });

  it('GET /v1/machine/bookings still filters by a valid status and reads an empty one as not given', async () => {
    const uid = await h.newBooking();
    const items = async (query: string) =>
      ((await (await list(query)).json()) as { items: Array<{ uid: string }> }).items.map((i) => i.uid);
    expect(await items('status=accepted')).toContain(uid);
    expect(await items('status=rejected')).not.toContain(uid);
    expect(await items('status=')).toContain(uid);
  });

  // The zod wording for an enum is not this test's business; the field name is.
  it.each(['status=accepted&status=cancelled', 'status=upcoming', 'cursor=a&cursor=b'])('GET /v1/machine/bookings?%s is a 400 naming the field', async (query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message.startsWith(query.startsWith('cursor') ? 'cursor: ' : 'status: ')).toBe(true);
  });

  it('GET /v1/machine/bookings keeps reading a single unreadable cursor as before (page one) and an empty one as not given', async () => {
    const uid = await h.newBooking();
    for (const query of ['cursor=junk', 'cursor=']) {
      const res = await list(query);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ uid: string }> };
      expect(body.items.map((item) => item.uid)).toContain(uid);
    }
  });
});
