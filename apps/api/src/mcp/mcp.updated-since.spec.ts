import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, idem, structured, type Harness } from './mcp-harness';

/**
 * `list_bookings` as a change feed: an agent that only has the MCP used to
 * re-read the whole list every few minutes to notice a new booking.
 * `updated_since` returns what was created or changed since its last check,
 * at any start time, and the tool names webhooks for push.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let h: Harness;
let introId: string;
let alexId: string;

beforeAll(async () => {
  h = await bootHarness();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  alexId = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

async function insertBooking(startMs: number, status: string, updatedAt: number): Promise<string> {
  const uid = randomUUID();
  await h.db.run(
    sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
        VALUES (${randomUUID()}, ${h.accountId}, ${uid}, ${introId}, ${alexId}, 'Intro Call', ${startMs}, ${startMs + 1_800_000}, ${status}, ${null}, ${updatedAt - DAY}, ${updatedAt})`,
  );
  return uid;
}

describe('list_bookings updated_since', () => {
  it('lists what changed since an instant, at any start time, and leaves out what did not', async () => {
    const now = Date.now();
    // Cancelled just now, for a time that already passed: a change to report.
    const cancelledPast = await insertBooking(now - 2 * DAY, 'cancelled', now);
    // Upcoming, but untouched for two days.
    const quietUpcoming = await insertBooking(now + 3 * DAY, 'accepted', now - 2 * DAY);
    // Upcoming and created a minute ago.
    const freshUpcoming = await insertBooking(now + 4 * DAY, 'accepted', now - 60_000);

    const reader = await h.connect(await h.key(['bookings:read']));
    const uids = async (args: Record<string, unknown>) =>
      structured<{ bookings: { uid: string }[] }>(await reader.callTool({ name: 'list_bookings', arguments: { limit: 50, ...args } })).bookings.map(
        (b) => b.uid,
      );

    const since = new Date(now - HOUR).toISOString();
    const changed = await uids({ updated_since: since });
    expect(changed).toContain(cancelledPast);
    expect(changed).toContain(freshUpcoming);
    expect(changed).not.toContain(quietUpcoming);

    // Nothing changed after now.
    const later = await uids({ updated_since: new Date(now + HOUR).toISOString() });
    expect(later).not.toContain(cancelledPast);
    expect(later).not.toContain(freshUpcoming);

    // It combines with the other filters: from still bounds the start time.
    const fromNow = await uids({ updated_since: since, from: new Date(now).toISOString() });
    expect(fromNow).toContain(freshUpcoming);
    expect(fromNow).not.toContain(cancelledPast);

    // Without it, the list still starts from now, as before.
    const plain = await uids({});
    expect(plain).not.toContain(cancelledPast);
    expect(plain).toContain(quietUpcoming);
  });

  it('shows a booking that gained an attendee, and hands back where to start next time', async () => {
    const now = Date.now();
    const quiet = await insertBooking(now + 5 * DAY, 'accepted', now - 2 * DAY);
    const reader = await h.connect(await h.key(['bookings:read']));
    const page = async (args: Record<string, unknown>) =>
      structured<{
        bookings: { uid: string; rescheduled_from_uid: string | null; rescheduled_to_uid: string | null }[];
        next_updated_since: string;
      }>(await reader.callTool({ name: 'list_bookings', arguments: { limit: 50, ...args } }));

    const first = await page({ updated_since: new Date(now - HOUR).toISOString() });
    expect(first.bookings.map((b) => b.uid)).not.toContain(quiet);
    // The next start is the server's own time, a little before the read.
    const next = Date.parse(first.next_updated_since);
    expect(next).toBeLessThanOrEqual(Date.now());
    expect(next).toBeGreaterThan(now - 5 * 60_000);

    const writer = await h.key(['bookings:write']);
    const added = await fetch(`${h.base}/v1/machine/bookings/${quiet}/attendees`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attendee: { name: 'Riley Guest', email: 'riley.guest@example.org', timeZone: 'UTC' } }),
    });
    expect(added.status).toBe(201);

    const second = await page({ updated_since: first.next_updated_since });
    const row = second.bookings.find((b) => b.uid === quiet);
    expect(row).toBeTruthy();
    expect(row!.rescheduled_from_uid).toBeNull();
    expect(row!.rescheduled_to_uid).toBeNull();
  });

  it('keeps the first page watermark across a walk through pages', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await insertBooking(now + (6 + i) * DAY, 'accepted', now);
    const reader = await h.connect(await h.key(['bookings:read']));
    type Page = { bookings: { uid: string }[]; next_cursor: string | null; next_updated_since: string };
    const read = async (args: Record<string, unknown>) =>
      structured<Page>(await reader.callTool({ name: 'list_bookings', arguments: { limit: 1, updated_since: new Date(now - HOUR).toISOString(), ...args } }));
    const first = await read({});
    expect(first.next_cursor).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await read({ cursor: first.next_cursor });
    expect(second.next_updated_since).toBe(first.next_updated_since);
    expect(second.bookings[0]!.uid).not.toBe(first.bookings[0]!.uid);
    // A cursor whose watermark was tampered with is refused, not misread.
    const bad = await reader.callTool({ name: 'list_bookings', arguments: { cursor: `${first.next_cursor!.split('.')[0]}.soon` } });
    expect(bad.isError).toBe(true);
  });

  it('reads a reschedule_booking move as one move: the old booking points to the new one', async () => {
    const client = await h.connect(await h.key(['availability:read', 'bookings:read', 'bookings:write']));
    const slots = structured<{ days: { slots: { start: string }[] }[] }>(
      await client.callTool({
        name: 'find_available_slots',
        arguments: { booking_page_url: 'https://calendar.example.test/acme/alex-rivera/intro-call', time_zone: 'America/New_York' },
      }),
    ).days.flatMap((d) => d.slots);
    const since = new Date(Date.now() - 60_000).toISOString();
    const made = structured<{ booking: { uid: string } }>(
      await client.callTool({
        name: 'create_booking',
        arguments: {
          event_type_id: introId,
          start: slots[3]!.start,
          attendee: { name: 'Morgan Mover', email: 'morgan.mover@example.org', time_zone: 'America/New_York' },
          answers: { company: 'Initech' },
          idempotency_key: idem('feed-move-create-01'),
        },
      }),
    );
    const moved = structured<{ booking: { uid: string }; previous_uid: string }>(
      await client.callTool({
        name: 'reschedule_booking',
        arguments: { booking_uid: made.booking.uid, start: slots[7]!.start, idempotency_key: idem('feed-move-resched-1') },
      }),
    );
    const rows = structured<{
      bookings: { uid: string; status: string; rescheduled_from_uid: string | null; rescheduled_to_uid: string | null }[];
    }>(await client.callTool({ name: 'list_bookings', arguments: { limit: 50, updated_since: since } })).bookings;
    const old = rows.find((b) => b.uid === made.booking.uid);
    const fresh = rows.find((b) => b.uid === moved.booking.uid);
    expect(old).toMatchObject({ status: 'cancelled', rescheduled_to_uid: moved.booking.uid });
    expect(fresh).toMatchObject({ rescheduled_from_uid: made.booking.uid });
  });

  it('describes the change feed and points to webhooks for push', async () => {
    const reader = await h.connect(await h.key(['bookings:read']));
    const { tools } = await reader.listTools();
    const tool = tools.find((t) => t.name === 'list_bookings')!;
    expect(tool.description).toContain('updated_since');
    expect(tool.description).toContain('webhook');
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('updated_since');
  });
});
