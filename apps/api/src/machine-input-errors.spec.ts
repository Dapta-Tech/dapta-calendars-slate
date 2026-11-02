import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
