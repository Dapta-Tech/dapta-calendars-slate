import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { InMemoryCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { createWebhook, sql } from '@slate/db';
import { AnalyticsEffects } from '../analytics-effects';
import { CalendarEffects } from '../calendar-effects';
import { CrmEffects } from '../crm-effects';
import { EmailEffects } from '../email-effects';
import { enqueueBookingWebhook } from '../booking-webhook';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';
import { TOOLS, type McpToolDeps } from './tools';
import type { McpCall } from './support';

/**
 * `create_event`: a host's own event on their own calendar, through the MCP.
 * The three requests it was built for ("block this afternoon to study", "a 1:1
 * with Daniel", "a one-hour call called Phone with three people"), what is
 * refused, and how the event then reads, moves and cancels like a booking
 * while dCal emails nobody, fires no webhook and writes nothing to a CRM.
 */

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const HOUR = 3_600_000;
const REF = 'cal-ext-owner';

type Event = {
  uid: string;
  kind: string;
  title: string | null;
  status: string;
  start: string;
  end: string;
  start_utc: string;
  end_utc: string;
  time_zone: string;
  event_type_id: string | null;
  event_type_title: string | null;
  duration_minutes: number | null;
  hosts: string[];
};
type Created = {
  event: Event;
  attendees: string[];
  calendar: string;
  conflicts_ignored: { kind: string; start: string; end: string; uid: string | null; title: string | null }[];
  calendar_checked: boolean;
  already_created: boolean;
};

let h: Harness;
let calendar: InMemoryCalendarProvider;
let effects: CalendarEffects;
const hostEvents = vi.spyOn(AnalyticsEffects.prototype, 'hostEvent');

/**
 * A Sunday at 08:00 UTC (03:00 or 04:00 in New York, where the seeded host
 * offers nothing) `weeks` weeks past the next two: every test its own day.
 */
function sunday(weeks: number): number {
  const d = new Date(Date.now() + 14 * 86_400_000);
  d.setUTCHours(8, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7) + 7 * weeks);
  return d.getTime();
}
const iso = (ms: number) => new Date(ms).toISOString();

async function outbox(uid: string) {
  return h.db.all<{ kind: string; action: string }>(
    sql`SELECT kind, action FROM outbox WHERE booking_uid = ${uid} ORDER BY created_at ASC, id ASC`,
  );
}

async function create(args: Record<string, unknown>, scopes = ALL) {
  const c = await h.connect(await h.key(scopes));
  return c.callTool({ name: 'create_event', arguments: { time_zone: 'America/New_York', ...args } });
}

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '500', MCP_RATE_LIMIT_CAPACITY: '500' });
  // A connected calendar for the owner (the host an API key acts for), read
  // for conflicts and written to. The provider behind every calendar effect is
  // the in-memory fake, so the outbox rows below can be run and inspected.
  calendar = new InMemoryCalendarProvider();
  effects = h.app.get(CalendarEffects);
  (effects as unknown as { calendar: CalendarProvider }).calendar = calendar;
  const owner = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
  await h.db.run(
    sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
        VALUES (${randomUUID()}, ${h.accountId}, ${owner}, 'external', ${REF}, 1, 1, ${Date.now()})`,
  );
  // A subscriber for every booking event: none may reach it about an event.
  await createWebhook(h.db, {
    accountId: h.accountId,
    subscriberUrl: 'https://hooks.example.test/dcal',
    eventTriggers: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
    key: randomBytes(32),
  });
});
afterAll(async () => {
  await h.close();
  hostEvents.mockRestore();
});
afterEach(() => {
  calendar.seedBusy(REF, []);
  hostEvents.mockClear();
});

describe('create_event', () => {
  it('blocks an afternoon with no guests, at a time no event type offers, and writes it to the calendar', async () => {
    const start = sunday(0);
    const out = structured<Created>(
      await create({ title: 'Study Dapti', start: iso(start), duration_minutes: 240, idempotency_key: idem('event-block-0001') }),
    );
    expect(out.event).toMatchObject({
      kind: 'event',
      title: 'Study Dapti',
      status: 'accepted',
      event_type_id: null,
      event_type_title: null,
      duration_minutes: 240,
      start_utc: iso(start),
      end_utc: iso(start + 4 * HOUR),
      time_zone: 'America/New_York',
      hosts: ['Alex Rivera'],
    });
    expect(out).toMatchObject({ attendees: [], calendar: 'queued', conflicts_ignored: [], calendar_checked: true, already_created: false });
    // Only the calendar write is queued: no email, no webhook, no CRM row.
    expect(await outbox(out.event.uid)).toEqual([{ kind: 'calendar', action: 'create' }]);

    await effects.runCalendarJob('create', out.event.uid);
    const written = calendar.created.at(-1)!;
    expect(written).toMatchObject({
      connectionRef: REF,
      title: 'Study Dapti',
      startUtc: iso(start),
      endUtc: iso(start + 4 * HOUR),
      attendeeEmails: ['alex@example.com'],
      requestConferenceLink: false,
      timeZone: 'America/New_York',
      sendInvitations: true,
    });
    expect(hostEvents).toHaveBeenCalledTimes(1);
    expect(hostEvents.mock.calls[0]![0]).toBe('host_event_created');
    expect(hostEvents.mock.calls[0]![2]).toMatchObject({
      channel: 'mcp',
      credential: 'api_key',
      attendee_count: 0,
      duration_minutes: 240,
      video_link: false,
      calendar: 'queued',
    });
  });

  it('a 1:1 with one guest and a video link: the calendar invites the guest and adds the link', async () => {
    const start = sunday(1);
    const out = structured<Created>(
      await create({
        title: '1a1 Daniel',
        start: iso(start),
        duration_minutes: 30,
        attendees: ['daniel@example.org'],
        video_link: true,
        idempotency_key: idem('event-1on1-0001'),
      }),
    );
    expect(out.attendees).toEqual(['daniel@example.org']);
    await effects.runCalendarJob('create', out.event.uid);
    expect(calendar.created.at(-1)).toMatchObject({
      title: '1a1 Daniel',
      attendeeEmails: ['alex@example.com', 'daniel@example.org'],
      requestConferenceLink: true,
      sendInvitations: true,
    });
    expect((await outbox(out.event.uid)).filter((r) => r.kind !== 'calendar')).toEqual([]);
  });

  it('a one-hour call called Phone with three people, by end time; the host and repeats are left out', async () => {
    const start = sunday(2);
    const out = structured<Created>(
      await create({
        title: 'Phone',
        start: iso(start),
        end: iso(start + HOUR),
        attendees: ['fausto@example.org', 'daniel@example.org', 'cele@example.org', 'Fausto@example.org', 'alex@example.com'],
        idempotency_key: idem('event-phone-0001'),
      }),
    );
    expect(out.event).toMatchObject({ title: 'Phone', duration_minutes: 60 });
    expect(out.attendees).toEqual(['fausto@example.org', 'daniel@example.org', 'cele@example.org']);
    expect(hostEvents.mock.calls[0]![2]).toMatchObject({ attendee_count: 3, duration_minutes: 60 });
  });

  it('refuses busy time on the calendar, listing it, and creates it over that time when told to', async () => {
    const start = sunday(3);
    calendar.seedBusy(REF, [{ startUtc: iso(start + HOUR), endUtc: iso(start + 2 * HOUR) }]);
    const args = { title: 'Deep work', start: iso(start), duration_minutes: 180, idempotency_key: idem('event-busy-0001') };
    const refused = errorText(await create(args));
    expect(refused).toMatch(/^CONFLICT: The host is busy then: busy on the connected calendar /);
    expect(refused).toContain('allow_conflicts');
    expect(await h.db.get(sql`SELECT id FROM booking WHERE title = 'Deep work'`)).toBeUndefined();
    expect(hostEvents).not.toHaveBeenCalled();

    const out = structured<Created>(await create({ ...args, allow_conflicts: true }));
    expect(out.conflicts_ignored).toHaveLength(1);
    expect(out.conflicts_ignored[0]).toMatchObject({ kind: 'calendar', uid: null, title: null });
    expect(new Date(out.conflicts_ignored[0]!.start).getTime()).toBe(start + HOUR);
    expect(new Date(out.conflicts_ignored[0]!.end).getTime()).toBe(start + 2 * HOUR);
    expect(hostEvents.mock.calls[0]![2]).toMatchObject({ allow_conflicts: true, conflicts_ignored: 1 });
  });

  it('never overlaps a dCal booking, even when told to ignore conflicts', async () => {
    const start = sunday(4);
    const uid = randomUUID();
    const et = (await h.db.get<{ id: string; member_id: string }>(sql`SELECT id, member_id FROM event_type WHERE slug = 'intro-call'`))!;
    await h.db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${h.accountId}, ${uid}, ${et.id}, ${et.member_id}, 'Intro Call with Sam Secret', ${start + HOUR}, ${start + HOUR + 1_800_000}, 'accepted', ${Date.now()}, ${Date.now()})`,
    );
    for (const allow_conflicts of [false, true]) {
      const text = errorText(
        await create({ title: 'Focus', start: iso(start), duration_minutes: 240, allow_conflicts, idempotency_key: idem(`event-taken-${allow_conflicts}`) }),
      );
      expect(text).toMatch(/^SLOT_TAKEN: That time overlaps the host's dCal bookings: "Intro Call" \(dCal /);
      expect(text).toContain(uid);
      // Named by its event type: the booking's own title names the invitee.
      expect(text).not.toContain('Sam Secret');
    }
  });

  it('replays a repeated key, and refuses it with other arguments', async () => {
    const start = sunday(5);
    const args = { title: 'Replay', start: iso(start), duration_minutes: 60, idempotency_key: idem('event-replay-0001') };
    const c = await h.connect(await h.key(ALL));
    const first = structured<Created>(await c.callTool({ name: 'create_event', arguments: args }));
    const again = structured<Created>(await c.callTool({ name: 'create_event', arguments: args }));
    expect(again.event.uid).toBe(first.event.uid);
    expect(again.already_created).toBe(true);
    expect(hostEvents).toHaveBeenCalledTimes(1);
    expect(await outbox(first.event.uid)).toEqual([{ kind: 'calendar', action: 'create' }]);
    expect(errorText(await c.callTool({ name: 'create_event', arguments: { ...args, title: 'Other' } }))).toMatch(/^IDEMPOTENCY_KEY_REUSED/);
  });

  it('refuses a key held to some event types, a date without a time, and an ambiguous length', async () => {
    const et = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
    const c = await h.connect(await h.key(ALL, { eventTypeIds: [et] }));
    const base = { title: 'X', start: iso(sunday(6)), duration_minutes: 30, idempotency_key: idem('event-refuse-0001') };
    expect(errorText(await c.callTool({ name: 'create_event', arguments: base }))).toMatch(/^INSUFFICIENT_SCOPE/);
    expect(errorText(await create({ ...base, start: '2031-01-05' }))).toMatch(/^INVALID_ARGUMENT: start needs a time/);
    expect(errorText(await create({ ...base, end: iso(sunday(6) + HOUR) }))).toMatch(/^INVALID_ARGUMENT: Give end or duration_minutes/);
    const noLength = { title: base.title, start: base.start, idempotency_key: base.idempotency_key };
    expect(errorText(await create(noLength))).toMatch(/^INVALID_ARGUMENT: Give end or duration_minutes/);
    expect(errorText(await create({ ...base, duration_minutes: undefined, end: base.start }))).toMatch(/end must be after start/);
  });

  it('with no calendar to write to, refuses attendees but still blocks the time in dCal', async () => {
    await h.db.run(sql`UPDATE connected_calendar SET is_destination = 0 WHERE external_id = ${REF}`);
    try {
      const start = sunday(7);
      const base = { title: 'Solo', start: iso(start), duration_minutes: 60 };
      expect(errorText(await create({ ...base, attendees: ['x@example.org'], idempotency_key: idem('event-nocal-0001') }))).toMatch(/^NO_CALENDAR/);
      expect(errorText(await create({ ...base, video_link: true, idempotency_key: idem('event-nocal-0002') }))).toMatch(/^NO_CALENDAR/);
      const out = structured<Created>(await create({ ...base, idempotency_key: idem('event-nocal-0003') }));
      expect(out.calendar).toBe('not_connected');
      expect(await outbox(out.event.uid)).toEqual([]);
    } finally {
      await h.db.run(sql`UPDATE connected_calendar SET is_destination = 1 WHERE external_id = ${REF}`);
    }
  });

  it('signed in, it is the signed-in member\'s own calendar, not the owner\'s', async () => {
    const jordan = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`))!.id;
    const def = TOOLS.find((t) => t.name === 'create_event')!;
    const deps = (h.gateway as unknown as { deps: McpToolDeps }).deps;
    const call: McpCall = {
      requestId: 'spec',
      protocolVersion: '2025-06-18',
      ip: '127.0.0.1',
      principal: {
        kind: 'oauth',
        keyId: `login:${jordan}`,
        prefix: 'login:jordan',
        accountId: h.accountId,
        memberId: jordan,
        scopes: ALL,
        eventTypeIds: null,
        expiresAtMs: null,
      },
    };
    const out = await def.run(
      { title: 'Jordan focus', start: iso(sunday(8)), duration_minutes: 60, idempotency_key: idem('event-jordan-0001') } as never,
      call,
      deps,
    );
    const row = await h.db.get<{ host_member_id: string }>(
      sql`SELECT host_member_id FROM booking WHERE uid = ${(out.data as Created).event.uid}`,
    );
    expect(row!.host_member_id).toBe(jordan);
    expect((out.data as Created).event.hosts).toEqual(['Jordan Lee']);
    // Jordan has no calendar connected: the event only blocks the time in dCal.
    expect((out.data as Created).calendar).toBe('not_connected');
  });
});

describe('an event after it is made', () => {
  let uid: string;
  let start: number;

  beforeAll(async () => {
    start = sunday(10);
    uid = structured<Created>(
      await create({
        title: 'Phone',
        start: iso(start),
        duration_minutes: 60,
        attendees: ['fausto@example.org', 'cele@example.org'],
        description: 'Agenda in the doc',
        idempotency_key: idem('event-life-0001'),
      }),
    ).event.uid;
  });

  it('lists with its own title and an empty event type, in a page the client validates', async () => {
    const c = await h.connect(await h.key(['bookings:read']));
    type Rows = { bookings: Array<Record<string, unknown>>; next_updated_since: string };
    const rows = structured<Rows>(await c.callTool({ name: 'list_bookings', arguments: { from: iso(start - HOUR), to: iso(start + HOUR) } }));
    expect(rows.bookings).toEqual([
      expect.objectContaining({ uid, kind: 'event', title: 'Phone', event_type_id: '', event_type_title: '', attendee_count: 2 }),
    ]);
    // The change feed carries it too.
    const feed = structured<Rows>(
      await c.callTool({ name: 'list_bookings', arguments: { updated_since: iso(Date.now() - 10 * 60_000) } }),
    );
    expect(feed.bookings.map((b) => b.uid)).toContain(uid);
    // A booking keeps its event type and no title.
    const booking = await h.newBooking();
    const all = structured<Rows>(await c.callTool({ name: 'list_bookings', arguments: { updated_since: iso(Date.now() - 60_000) } }));
    expect(all.bookings.find((b) => b.uid === booking)).toMatchObject({ kind: 'booking', title: null, event_type_title: 'Intro Call' });
  });

  it('reads with its attendees and body', async () => {
    const c = await h.connect(await h.key(['bookings:read']));
    const got = structured<{ booking: Event & { description?: unknown }; invitee_supplied: { attendees: { email: string }[] } }>(
      await c.callTool({ name: 'get_booking', arguments: { booking_uid: uid } }),
    );
    expect(got.booking).toMatchObject({ uid, kind: 'event', title: 'Phone', event_type_id: null, duration_minutes: 60 });
    expect(got.invitee_supplied.attendees.map((a) => a.email)).toEqual(['fausto@example.org', 'cele@example.org']);
  });

  it('is out of reach of a key held to some event types', async () => {
    const et = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
    const c = await h.connect(await h.key(['bookings:read'], { eventTypeIds: [et] }));
    expect(errorText(await c.callTool({ name: 'get_booking', arguments: { booking_uid: uid } }))).toMatch(/^NOT_FOUND/);
    const rows = structured<{ bookings: { uid: string }[] }>(
      await c.callTool({ name: 'list_bookings', arguments: { from: iso(start - HOUR), to: iso(start + HOUR) } }),
    );
    expect(rows.bookings).toEqual([]);
  });

  it('moves to any time with its length, and only the calendar is told', async () => {
    const c = await h.connect(await h.key(ALL));
    // 05:30 in New York on the same Sunday: no event type offers it.
    const moved = structured<{ booking: Event; previous_uid: string }>(
      await c.callTool({
        name: 'reschedule_booking',
        arguments: { booking_uid: uid, start: iso(start + 2.5 * HOUR), idempotency_key: idem('event-move-0001') },
      }),
    );
    expect(moved.booking).toMatchObject({ kind: 'event', title: 'Phone', duration_minutes: 60, start_utc: iso(start + 2.5 * HOUR) });
    expect(moved.previous_uid).toBe(uid);
    const rows = [...(await outbox(uid)), ...(await outbox(moved.booking.uid))];
    expect(rows.every((r) => r.kind === 'calendar')).toBe(true);
    expect(rows.map((r) => r.action)).toContain('reschedule');
    uid = moved.booking.uid;
  });

  it('cancels: the calendar removes it and tells its attendees; dCal emails nobody', async () => {
    await effects.runCalendarJob('create', uid);
    const c = await h.connect(await h.key(ALL));
    const out = structured<{ booking: Event }>(await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: uid, reason: 'Moved to next week' } }));
    expect(out.booking).toMatchObject({ uid, kind: 'event', status: 'cancelled' });
    const rows = await outbox(uid);
    expect(rows.filter((r) => r.kind !== 'calendar')).toEqual([]);
    expect(rows.map((r) => r.action)).toContain('delete');
    await effects.runCalendarJob('delete', uid);
    expect(calendar.deleted.at(-1)).toMatchObject({ connectionRef: REF, sendInvitations: true });
  });
});

describe('the effects skip an event and keep every booking', () => {
  it('emails, webhooks and the CRM', async () => {
    const event = structured<Created>(
      await create({ title: 'Guarded', start: iso(sunday(12)), duration_minutes: 30, attendees: ['g@example.org'], idempotency_key: idem('event-guard-0001') }),
    ).event.uid;
    const booking = await h.newBooking();
    await h.db.run(
      sql`INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, created_at)
          SELECT ${randomUUID()}, id, 'Sam', 'sam@example.org', 'UTC', ${Date.now()} FROM booking WHERE uid = ${booking}`,
    );
    const email = h.app.get(EmailEffects);
    for (const uid of [event, booking]) {
      await email.enqueueConfirmation(uid);
      await email.enqueueReminders(uid);
      await email.enqueueCancellation(uid, { reason: null });
    }
    const mails = async (uid: string) => (await outbox(uid)).filter((r) => r.kind === 'email').length;
    expect(await mails(event)).toBe(0);
    expect(await mails(booking)).toBeGreaterThan(0);

    expect(await enqueueBookingWebhook(h.db, h.accountId, 'booking.cancelled', { uid: event })).toBe(0);
    expect(await enqueueBookingWebhook(h.db, h.accountId, 'booking.cancelled', { uid: booking })).toBe(1);

    const crmRows: string[] = [];
    const crm = new CrmEffects(
      { enabled: true } as unknown as ConstructorParameters<typeof CrmEffects>[0],
      h.db,
    );
    crm.onBookingAccepted(event);
    crm.onBookingAccepted(booking);
    await vi.waitFor(async () => {
      const rows = await h.db.all<{ booking_uid: string }>(sql`SELECT booking_uid FROM outbox WHERE kind = 'crm'`);
      crmRows.splice(0, crmRows.length, ...rows.map((r) => r.booking_uid));
      expect(crmRows).toContain(booking);
    });
    expect(crmRows).not.toContain(event);
  });
});
