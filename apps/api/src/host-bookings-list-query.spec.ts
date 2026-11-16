import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './mcp/mcp-harness';

/**
 * The dashboard's bookings list refuses a query value it cannot read with a
 * 400 naming the field, as the API-key list does. Before, a bad date read as
 * NaN (a silently empty list) and a bad limit reached SQL (a 500).
 */
describe('GET /v1/host/bookings: an unreadable query value is a 400 naming the field', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const list = (query: string) => fetch(`${h.base}/v1/host/bookings?${query}`);

  it.each([
    ['from=tomorrow', 'from: Invalid date'],
    ['to=next-week', 'to: Invalid date'],
    ['limit=abc', 'limit: Expected an integer'],
    ['limit=10.5', 'limit: Expected an integer'],
    ['limit=1&limit=2', 'limit: Expected string, received array'],
  ])('%s', async (query, message) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'BAD_REQUEST', message });
  });

  it('keeps accepting any date the server can read and clamping the limit', async () => {
    const uid = await h.newBooking();
    const res = await list('from=2000-01-01&to=2100-01-01T00:00:00Z&limit=999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ uid: string }> };
    expect(body.items.length).toBeLessThanOrEqual(200);
    expect(body.items.map((item) => item.uid)).toContain(uid);
  });

  it('still filters by a valid status', async () => {
    const uid = await h.newBooking();
    const items = async (status: string) =>
      ((await (await list(`status=${status}`)).json()) as { items: Array<{ uid: string }> }).items.map((i) => i.uid);
    expect(await items('accepted')).toContain(uid);
    expect(await items('rejected')).not.toContain(uid);
  });

  it('keeps reading an empty value as not given', async () => {
    const uid = await h.newBooking();
    const res = await list('from=&to=&limit=&status=');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ uid: string }> };
    expect(body.items.map((item) => item.uid)).toContain(uid);
  });

  // The zod wording for an enum is not this test's business; the field name is.
  it.each(['status=accepted&status=cancelled', 'status=upcoming'])('GET /v1/host/bookings?%s is a 400 naming status', async (query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message.startsWith('status: ')).toBe(true);
  });
});
