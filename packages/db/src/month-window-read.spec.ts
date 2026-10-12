import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BusyInterval, CalendarProvider, ListBusyInput } from '@slate/calendar';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { sql } from 'drizzle-orm';
import { getAvailability, getPublicProfile } from './repository';
import { getTeamAvailability, getTeamProfile } from './parity';

/**
 * The booking page reads its availability a month at a time (Phase 5): the
 * visible month first, the others as the visitor nears them. That turns every
 * month edge into a window edge, and makes the public profile the thing the
 * page paints from before any of it lands.
 */

const MIN = 60_000;
const DAY = 86_400_000;

/** A calendar backend that answers only what it is asked, like a real one. */
class WindowedBackend {
  readonly asked: ListBusyInput[] = [];
  constructor(private readonly events: BusyInterval[]) {}
  get provider(): CalendarProvider {
    return {
      enabled: true,
      listBusy: async (input: ListBusyInput) => {
        this.asked.push(input);
        const lo = Date.parse(input.fromUtc);
        const hi = Date.parse(input.toUtc);
        return this.events.filter((e) => Date.parse(e.startUtc) < hi && Date.parse(e.endUtc) > lo);
      },
    } as unknown as CalendarProvider;
  }
}

describe('a month-sized availability read', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  const args = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'generic'}, ${'conn-1'}, ${null}, 0, 1, ${Date.now()})`,
    );
  });

  /** A slot the event offers about a week out, and the event's shape. */
  async function aFreeSlot() {
    const fromMs = Date.now() + 7 * DAY;
    const free = await getAvailability(db, { ...args, fromMs, toMs: fromMs + 7 * DAY });
    const startMs = Date.parse(free!.slots[2]!.startUtc);
    const et = (await db.get<{ length_minutes: number; before_event_buffer: number; after_event_buffer: number }>(
      sql`SELECT length_minutes, before_event_buffer, after_event_buffer FROM event_type WHERE slug = 'intro-call'`,
    ))!;
    return { startMs, et };
  }

  it('asks the calendar for the window and the length of a slot past it, nothing more', async () => {
    const { startMs, et } = await aFreeSlot();
    const backend = new WindowedBackend([]);
    const fromMs = startMs - 2 * 60 * MIN;
    const toMs = startMs + MIN;
    await getAvailability(db, { ...args, fromMs, toMs }, backend.provider);
    expect(backend.asked).toHaveLength(1);
    expect(Date.parse(backend.asked[0]!.fromUtc)).toBe(fromMs - et.before_event_buffer * MIN);
    expect(Date.parse(backend.asked[0]!.toUtc)).toBe(toMs + (et.length_minutes + et.after_event_buffer) * MIN);
  });

  it('a slot that starts before the window ends is checked against the meeting right after it', async () => {
    const { startMs } = await aFreeSlot();
    // The window ends one minute into the slot; the host's meeting starts ten
    // minutes into it. Read over the bare window, that meeting is never seen
    // and the slot is offered on a calendar that is busy.
    const fromMs = startMs - 2 * 60 * MIN;
    const toMs = startMs + MIN;
    const meeting = { startUtc: new Date(startMs + 10 * MIN).toISOString(), endUtc: new Date(startMs + 20 * MIN).toISOString() };
    const offered = await getAvailability(db, { ...args, fromMs, toMs }, new WindowedBackend([meeting]).provider);
    expect(offered!.slots.map((s) => s.startUtc)).not.toContain(new Date(startMs).toISOString());
    // Without the meeting the same window offers it, so the meeting is why.
    const free = await getAvailability(db, { ...args, fromMs, toMs }, new WindowedBackend([]).provider);
    expect(free!.slots.map((s) => s.startUtc)).toContain(new Date(startMs).toISOString());
  });

  it('two adjacent month windows offer exactly what one read across both does', async () => {
    const { startMs } = await aFreeSlot();
    const meetings = [0, 1, 2, 3].map((i) => ({
      startUtc: new Date(startMs + i * DAY + 15 * MIN).toISOString(),
      endUtc: new Date(startMs + i * DAY + 40 * MIN).toISOString(),
    }));
    const fromMs = startMs - DAY;
    const edgeMs = startMs + 2 * DAY + 5 * MIN;
    const toMs = startMs + 5 * DAY;
    const backend = new WindowedBackend(meetings);
    const whole = await getAvailability(db, { ...args, fromMs, toMs }, backend.provider);
    const first = await getAvailability(db, { ...args, fromMs, toMs: edgeMs }, backend.provider);
    const second = await getAvailability(db, { ...args, fromMs: edgeMs, toMs }, backend.provider);
    expect([...first!.slots, ...second!.slots].map((s) => s.startUtc)).toEqual(whole!.slots.map((s) => s.startUtc));
  });

  it('the team path reads past its window edge too', async () => {
    const backend = new WindowedBackend([]);
    const fromMs = Date.now() + 7 * DAY;
    const toMs = fromMs + 3 * DAY;
    await getTeamAvailability(db, { accountCode: 'acme', teamSlug: 'sales', slug: 'team-demo', fromMs, toMs }, backend.provider);
    // Only alex-rivera has a connection; the read reaches a 30-minute slot past the edge.
    expect(backend.asked).toHaveLength(1);
    expect(Date.parse(backend.asked[0]!.toUtc)).toBe(toMs + 30 * MIN);
  });
});

describe('the public listing carries what the event page paints first', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  const window = () => ({ fromMs: Date.now(), toMs: Date.now() + DAY });

  it("the event's location and zone match what its availability read answers", async () => {
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    const listed = profile!.eventTypes.find((e) => e.slug === 'intro-call')!;
    const read = await getAvailability(db, { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...window() });
    expect(listed.timeZone).toBe(read!.timeZone);
    expect(listed.location).toEqual(read!.eventType.location);
  });

  it("an event on its own schedule is listed in that schedule's zone, and a dangling one falls back", async () => {
    const { id: accountId } = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!;
    const { id: memberId } = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!;
    const scheduleId = randomUUID();
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Madrid hours'}, ${'Europe/Madrid'}, ${Date.now()})`,
    );
    await db.run(sql`UPDATE event_type SET schedule_id = ${scheduleId} WHERE slug = 'intro-call'`);
    const zoneOf = async () =>
      (await getPublicProfile(db, 'acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.timeZone;
    const readZone = async () =>
      (await getAvailability(db, { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...window() }))!.timeZone;
    expect(await zoneOf()).toBe('Europe/Madrid');
    expect(await zoneOf()).toBe(await readZone());

    await db.run(sql`UPDATE event_type SET schedule_id = ${'gone'} WHERE slug = 'intro-call'`);
    expect(await zoneOf()).toBe('America/New_York');
    expect(await zoneOf()).toBe(await readZone());
  });

  it("a team event's listing carries its location", async () => {
    const team = await getTeamProfile(db, 'acme', 'sales');
    const listed = team!.eventTypes.find((e) => e.slug === 'team-demo')!;
    const read = await getTeamAvailability(db, { accountCode: 'acme', teamSlug: 'sales', slug: 'team-demo', ...window() });
    expect(listed.location).toEqual(read!.eventType.location);
  });
});
