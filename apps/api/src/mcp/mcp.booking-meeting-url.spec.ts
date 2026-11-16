import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { loadBookingMeetingUrl, sql } from '@slate/db';
import { CalendarEffects } from '../calendar-effects';
import { bootHarness, idem, structured, type Harness } from './mcp-harness';
import type { McpToolDeps } from './tools';

/**
 * GEN-1946: a booking on a video-meeting event type answers with where it
 * happens and its join link, the one the confirmation email carries (both read
 * `booking_reference`, ADR 0007). The link comes from the calendar write, which
 * the outbox runs after the booking: here the spec drains that write while the
 * tool is still answering, as the worker does in production.
 */

type Booking = { uid: string; status: string; location: string | null; location_kind: string | null; meeting_url: string | null; meeting_url_status: string };
const TZ = 'America/Bogota';
let h: Harness;
let key: string;
let effects: CalendarEffects;
let approvalId: string;

/** A tool call with the spec's key, or with no sign-in at all when `token` is undefined. */
async function call(name: string, args: Record<string, unknown>, token: string | undefined = key) {
  const result = await (await h.connect(token)).callTool({ name, arguments: args });
  return { data: structured<{ booking: Booking; bookings?: (Booking & { uid: string })[] }>(result), text: (result.content as { text: string }[])[0]!.text };
}

async function firstSlot(eventTypeId: string, tool = 'find_available_slots'): Promise<string> {
  const out = await call(tool, { event_type_id: eventTypeId, time_zone: TZ, max_slots: 1 });
  return (out.data as unknown as { days: { slots: { start: string }[] }[] }).days[0]!.slots[0]!.start;
}

/** The outbox worker's part: run the next calendar create once it is queued, and mark it done. */
async function drainCalendarWrite(): Promise<void> {
  for (;;) {
    const row = await h.db.get<{ id: string; booking_uid: string }>(
      sql`SELECT id, booking_uid FROM outbox WHERE kind = 'calendar' AND action = 'create' AND status = 'pending' LIMIT 1`,
    );
    if (row) {
      await effects.runCalendarJob('create', row.booking_uid);
      await h.db.run(sql`UPDATE outbox SET status = 'done' WHERE id = ${row.id}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  h = await bootHarness();
  key = await h.key(['availability:read', 'bookings:read', 'bookings:write']);
  const calendar = new InMemoryCalendarProvider();
  calendar.mintRooms = true;
  effects = h.app.get(CalendarEffects);
  (effects as unknown as { calendar: CalendarProvider }).calendar = calendar;
  // Specs run with no worker, so the tools would not wait at all; production waits.
  (h.gateway as unknown as { deps: McpToolDeps }).deps.meetingUrlWaitMs = 5_000;
  const alex = (await h.db.get<{ id: string; default_schedule_id: string }>(
    sql`SELECT id, default_schedule_id FROM member WHERE handle = 'alex-rivera'`,
  ))!;
  const video = JSON.stringify({ kind: 'conferencing', detail: null });
  await h.db.run(sql`UPDATE event_type SET locations = ${video} WHERE account_id = ${h.accountId} AND slug IN ('intro-call', 'team-demo')`);
  approvalId = randomUUID();
  await h.db.run(
    sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, locations, schedule_id, hidden,
          minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval, requires_confirmation, created_at)
        VALUES (${approvalId}, ${h.accountId}, ${alex.id}, 'video-request', 'Video request', 30, ${video}, ${alex.default_schedule_id}, 0,
          120, 0, 0, 30, 1, ${Date.now()})`,
  );
  // Both hosts of the round-robin team can be assigned, so both write to a calendar.
  for (const handle of ['alex-rivera', 'jordan-lee'])
    await h.db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          SELECT ${randomUUID()}, ${h.accountId}, id, 'external', ${`cal-ext-${handle}`}, 1, 1, ${Date.now()} FROM member WHERE handle = ${handle}`,
    );
});
afterAll(async () => {
  await h.close();
});

describe('a booking on a video meeting carries its location and link (GEN-1946)', () => {
  it('create_booking answers with the link the email carries, and get_booking and list_bookings read it at once', async () => {
    const intro = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} AND slug = 'intro-call'`))!.id;
    const [created] = await Promise.all([
      call('create_booking', {
        event_type_id: intro,
        start: await firstSlot(intro),
        attendee: { name: 'Ana Video', email: 'ana.video@example.org', time_zone: TZ },
        answers: { company: 'Acme' },
        idempotency_key: idem('gen1946-booking-0001'),
      }),
      drainCalendarWrite(),
    ]);
    const link = await loadBookingMeetingUrl(h.db, created.data.booking.uid);
    const expected = { location_kind: 'conferencing', meeting_url: link, meeting_url_status: 'ready' };
    expect(link).toMatch(/^https:\/\/video\.example\//);
    expect(created.data.booking).toMatchObject({ status: 'accepted', location: 'Online meeting', ...expected });
    expect(created.text).toContain(`Video: ${link}.`);
    expect((await call('get_booking', { booking_uid: created.data.booking.uid })).data.booking).toMatchObject(expected);
    const listed = (await call('list_bookings', { time_zone: TZ })).data.bookings!;
    expect(listed.find((b) => b.uid === created.data.booking.uid)).toMatchObject(expected);
  });

  it('a request says the link comes when the host confirms, and confirm_booking answers with it', async () => {
    const requested = await call('create_booking', {
      event_type_id: approvalId,
      start: await firstSlot(approvalId),
      attendee: { name: 'Bo Video', email: 'bo.video@example.org', time_zone: TZ },
      idempotency_key: idem('gen1946-request-0001'),
    });
    const uid = requested.data.booking.uid;
    expect(requested.data.booking).toMatchObject({ status: 'pending', location: 'Online meeting', meeting_url: null, meeting_url_status: 'on_confirmation' });
    expect(requested.text).toContain('The video link is created when the host confirms.');
    const [confirmed] = await Promise.all([call('confirm_booking', { booking_uid: uid, idempotency_key: idem('gen1946-confirm-0001') }), drainCalendarWrite()]);
    expect(confirmed.data.booking).toMatchObject({ status: 'accepted', meeting_url: await loadBookingMeetingUrl(h.db, uid), meeting_url_status: 'ready' });
  });

  it.each([
    { tool: 'book_meeting', how: 'public', slots: 'find_available_slots', slug: 'intro-call', link: { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', answers: { company: 'Acme' } } },
    { tool: 'book_team_meeting', how: 'public', slots: 'find_team_slots', slug: 'team-demo', link: { booking_page_url: 'https://x.test/acme/team/sales/team-demo' } },
    { tool: 'book_team_meeting', how: 'by-id', slots: 'find_team_slots', slug: 'team-demo', link: {} },
  ])('$tool ($how: a public link with no sign-in, or the event type id with a key) answers with the link, and so does its replay', async ({ tool, how, slots, slug, link }) => {
    const id = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} AND slug = ${slug}`))!.id;
    const token = how === 'by-id' ? key : undefined;
    const args = { ...link, ...(token ? { event_type_id: id } : {}), start: await firstSlot(id, slots), attendee: { name: 'Cy Video', email: `${tool}-${how}@example.org`, time_zone: TZ }, idempotency_key: idem(`gen1946-${tool}-${how}`) };
    const [booked] = await Promise.all([call(tool, args, token), drainCalendarWrite()]);
    const expected = { location: 'Online meeting', location_kind: 'conferencing', meeting_url: await loadBookingMeetingUrl(h.db, booked.data.booking.uid), meeting_url_status: 'ready' };
    expect(expected.meeting_url).toMatch(/^https:\/\/video\.example\//);
    expect(booked.data.booking).toMatchObject(expected);
    expect((await call(tool, args, token)).data.booking).toMatchObject(expected);
  });
});
