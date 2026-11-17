import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * Booking limits through the MCP tools, against the real app: get_event_type
 * shows the four limits (null = no limit); once a day is full,
 * find_available_slots lists nothing on it, and a hold, a booking or a move
 * into it is refused saying the limit is why.
 */
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const hostDay = (iso: string | number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );

let h: Harness;
let introId: string;

beforeAll(async () => {
  h = await bootHarness();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

describe('booking limits over MCP', () => {
  it('get_event_type shows the four limits, null when unset', async () => {
    await h.db.run(sql`UPDATE event_type SET max_bookings_per_day = 2, max_minutes_per_week = 300 WHERE id = ${introId}`);
    const c = await h.connect(await h.key(['event-types:read']));
    const got = structured<{ event_type: Record<string, unknown> }>(
      await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } }),
    );
    expect(got.event_type).toMatchObject({
      max_bookings_per_day: 2,
      max_bookings_per_week: null,
      max_minutes_per_day: null,
      max_minutes_per_week: 300,
    });
  });

  it('find_available_slots lists no time on a full day', async () => {
    const seeded = (await h.db.get<{ start_ms: number }>(sql`SELECT start_ms FROM booking WHERE event_type_id = ${introId} AND status = 'accepted' ORDER BY start_ms LIMIT 1`))!;
    await h.db.run(sql`UPDATE event_type SET max_bookings_per_day = 1, max_minutes_per_week = NULL WHERE id = ${introId}`);
    const r = structured<{ days: { slots: { start_utc: string }[] }[] }>(
      await (await h.connect()).callTool({
        name: 'find_available_slots',
        arguments: { booking_page_url: PAGE, time_zone: 'UTC', end: new Date(Date.now() + 14 * 86_400_000).toISOString() },
      }),
    );
    const starts = r.days.flatMap((d) => d.slots.map((s) => s.start_utc));
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.filter((s) => hostDay(s) === hostDay(Number(seeded.start_ms)))).toEqual([]);
  });

  it('hold_slot, book_meeting and reschedule_booking say the booking limit is why a full day refuses', async () => {
    const seeded = Number((await h.db.get<{ start_ms: number }>(sql`SELECT start_ms FROM booking WHERE event_type_id = ${introId} AND status = 'accepted' ORDER BY start_ms LIMIT 1`))!.start_ms);
    const intoD = new Date(seeded + 3_600_000).toISOString();
    const full = /^INVALID_SLOT: That day has reached this event type's booking limit/;
    const who = { name: 'Limit', email: 'limit@example.org', time_zone: 'UTC' };
    const anon = await h.connect();
    expect(errorText(await anon.callTool({ name: 'hold_slot', arguments: { booking_page_url: PAGE, start: intoD, time_zone: 'UTC', idempotency_key: idem('limits-hold-001') } }))).toMatch(full);
    expect(errorText(await anon.callTool({ name: 'book_meeting', arguments: { booking_page_url: PAGE, start: intoD, attendee: who, answers: { company: 'c' }, idempotency_key: idem('limits-book-001') } }))).toMatch(full);
    const keyed = await h.connect(await h.key(['availability:read', 'bookings:read', 'bookings:write']));
    const slots = structured<{ days: { slots: { start: string; start_utc: string }[] }[] }>(
      await keyed.callTool({ name: 'find_available_slots', arguments: { event_type_id: introId, time_zone: 'UTC', end: new Date(Date.now() + 14 * 86_400_000).toISOString() } }),
    ).days.flatMap((d) => d.slots);
    const made = structured<{ booking: { uid: string } }>(
      await keyed.callTool({ name: 'create_booking', arguments: { event_type_id: introId, start: slots.at(-1)!.start, attendee: who, answers: { company: 'c' }, idempotency_key: idem('limits-make-001') } }),
    );
    expect(errorText(await keyed.callTool({ name: 'reschedule_booking', arguments: { booking_uid: made.booking.uid, start: intoD, idempotency_key: idem('limits-move-001') } }))).toMatch(full);
  });
});
