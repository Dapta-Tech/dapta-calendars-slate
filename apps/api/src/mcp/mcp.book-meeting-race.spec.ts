import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@slate/db';
import { BookingService } from '../booking.service';
import { CalV2Service } from '../cal-v2.service';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * book_meeting and its idempotency record when two calls with the same key race
 * (a retry after a timeout, or a client that sends twice). `BookingService.book`
 * is wrapped so a test can run the twin call to completion inside the first
 * call's booking step, then give the first call the answer the booking core
 * gives it in that interleaving: its duplicate check by key ran before the
 * twin's insert committed, so the core refuses the time as taken.
 */
const writes = vi.hoisted(() => ({ book_meeting: 0 }));
vi.mock('@slate/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slate/db')>();
  return {
    ...real,
    completeApiIdempotency: async (...args: Parameters<typeof real.completeApiIdempotency>) => {
      const written = await real.completeApiIdempotency(...args);
      if (written && args[2] === 201) writes.book_meeting += 1;
      return written;
    },
  };
});

const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const TEAM = 'https://calendar.example.test/acme/team/sales/team-demo';
type Booked = { booking: { uid: string; status: string; start_utc: string }; replayed: boolean };

let h: Harness;
const realBook = BookingService.prototype.book;
let twin: (() => Promise<void>) | null = null;
/**
 * What the first call's booking step does around its twin: `taken` runs the
 * twin, then answers SLOT_TAKEN; `real` runs the twin, then books for real (the
 * core finds the twin's booking by key); `throw` runs the twin, then fails the
 * way a unique index on the key fails on SQLite; `after` books for real first
 * and runs the twin before this call stores its result.
 */
let twinAnswer: 'taken' | 'real' | 'throw' | 'after' = 'taken';
const book = vi.spyOn(BookingService.prototype, 'book').mockImplementation(async function (this: BookingService, ...args: Parameters<BookingService['book']>) {
  if (twin) {
    const run = twin;
    twin = null;
    if (twinAnswer === 'after') {
      const out = await realBook.apply(this, args);
      await run();
      return out;
    }
    await run();
    if (twinAnswer === 'taken') return { error: 'SLOT_TAKEN', message: 'That time is no longer available.', status: 409 };
    if (twinAnswer === 'throw') throw new Error('UNIQUE constraint failed: booking.idempotency_key');
  }
  return realBook.apply(this, args);
});
// One failing read of a booking, to stand for a transient database error.
let failNextRead = false;
const realRead = CalV2Service.prototype.bookingResponse;
const read = vi.spyOn(CalV2Service.prototype, 'bookingResponse').mockImplementation(async function (this: CalV2Service, ...args: Parameters<CalV2Service['bookingResponse']>) {
  if (failNextRead) {
    failNextRead = false;
    throw new Error('connection pool exhausted');
  }
  return realRead.apply(this, args);
});

const realTeamBook = BookingService.prototype.teamBook;
const teamBook = vi.spyOn(BookingService.prototype, 'teamBook').mockImplementation(async function (this: BookingService, ...args: Parameters<BookingService['teamBook']>) {
  if (twin) {
    const run = twin;
    twin = null;
    await run();
    return { error: 'SLOT_TAKEN', message: 'That time is no longer available.', status: 409 };
  }
  return realTeamBook.apply(this, args);
});

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '400', MCP_RATE_LIMIT_CAPACITY: '800', RATE_LIMIT_CAPACITY: '800' });
});
afterAll(async () => {
  book.mockRestore();
  teamBook.mockRestore();
  read.mockRestore();
  await h.close();
});
afterEach(() => {
  twin = null;
  failNextRead = false;
  twinAnswer = 'taken';
  writes.book_meeting = 0;
});

async function start(nth: number, page = PAGE): Promise<string> {
  const c = await h.connect();
  const r = structured<{ days: { slots: { start: string }[] }[] }>(
    await c.callTool({ name: page === TEAM ? 'find_team_slots' : 'find_available_slots', arguments: { booking_page_url: page, time_zone: 'UTC' } }),
  );
  return r.days.flatMap((d) => d.slots)[nth]!.start;
}

const meeting = (at: string, key: string) => ({
  booking_page_url: PAGE,
  start: at,
  attendee: { name: 'Race Invitee', email: `${key}@example.org`, time_zone: 'UTC' },
  answers: { company: 'Race Co' },
  idempotency_key: idem(key),
});

describe('book_meeting with two calls on one key', () => {
  it('a call that loses the race to its own twin answers the twin\'s booking and never stores a refusal over it', async () => {
    const [first, second, third] = [await h.connect(), await h.connect(), await h.connect()];
    const args = meeting(await start(6), 'race-key-0001');
    let winner: Booked | undefined;
    twinAnswer = 'taken';
    twin = async () => {
      winner = structured<Booked>(await second.callTool({ name: 'book_meeting', arguments: args }));
    };
    const loser = await first.callTool({ name: 'book_meeting', arguments: args });
    expect(winner?.booking.status).toBe('accepted');
    // The loser is told about the booking its twin made, not SLOT_TAKEN.
    expect(structured<Booked>(loser)).toMatchObject({ replayed: true, booking: { uid: winner!.booking.uid } });
    // And every later retry still finds that booking.
    expect(structured<Booked>(await third.callTool({ name: 'book_meeting', arguments: args }))).toMatchObject({ replayed: true, booking: { uid: winner!.booking.uid } });
  });

  it('a stored success is never written over by a racing twin', async () => {
    const [first, second] = [await h.connect(), await h.connect()];
    const args = meeting(await start(10), 'race-key-0002');
    let winner: Booked | undefined;
    twinAnswer = 'real';
    twin = async () => {
      winner = structured<Booked>(await second.callTool({ name: 'book_meeting', arguments: args }));
    };
    // The first call's own booking step then finds the twin's booking by key.
    const late = structured<Booked>(await first.callTool({ name: 'book_meeting', arguments: args }));
    expect(late.booking.uid).toBe(winner!.booking.uid);
    expect(late.replayed).toBe(true);
    expect(writes.book_meeting).toBe(1);
  });

  it('a refusal stored on a key never hides the booking made under it: the booking answers and the record heals', async () => {
    const c = await h.connect();
    const args = meeting(await start(14), 'race-key-0003');
    const booked = structured<Booked>(await c.callTool({ name: 'book_meeting', arguments: args }));
    // As if a losing twin had stored its refusal after the booking was made.
    await h.db.run(
      sql`UPDATE api_idempotency SET status_code = ${409}, response_body = ${JSON.stringify({ error: 'SLOT_TAKEN', message: 'That time is no longer available.' })}
          WHERE path = 'book_meeting' AND response_body LIKE ${`%${booked.booking.uid}%`}`,
    );
    const retry = structured<Booked>(await c.callTool({ name: 'book_meeting', arguments: args }));
    expect(retry).toMatchObject({ replayed: true, booking: { uid: booked.booking.uid } });
    const record = await h.db.get<{ status_code: number | string }>(
      sql`SELECT status_code FROM api_idempotency WHERE path = 'book_meeting' AND response_body LIKE ${`%${booked.booking.uid}%`}`,
    );
    expect(Number(record!.status_code)).toBe(201);
  });

  it('book_team_meeting on a team page: the losing twin answers the twin\'s booking and says nothing was sent', async () => {
    const [first, second] = [await h.connect(), await h.connect()];
    const at = await start(8, TEAM);
    const args = {
      booking_page_url: TEAM,
      start: at,
      attendee: { name: 'Team Race', email: 'team-race@example.org', time_zone: 'UTC' },
      idempotency_key: idem('race-key-0004'),
    };
    let winner: { booking: { uid: string } } | undefined;
    twin = async () => {
      winner = structured<{ booking: { uid: string } }>(await second.callTool({ name: 'book_team_meeting', arguments: args }));
    };
    const loser = structured<{ booking: { uid: string }; next_step: string }>(await first.callTool({ name: 'book_team_meeting', arguments: args }));
    expect(loser.booking.uid).toBe(winner!.booking.uid);
    expect(loser.next_step).toContain('nothing was sent again');
  });

  it('a booking step that fails outright (the key\'s unique index) still answers the twin\'s booking', async () => {
    const [first, second] = [await h.connect(), await h.connect()];
    const args = meeting(await start(18), 'race-key-0005');
    let winner: Booked | undefined;
    twinAnswer = 'throw';
    twin = async () => {
      winner = structured<Booked>(await second.callTool({ name: 'book_meeting', arguments: args }));
    };
    expect(structured<Booked>(await first.callTool({ name: 'book_meeting', arguments: args }))).toMatchObject({ replayed: true, booking: { uid: winner!.booking.uid } });
  });

  it('the call that made the booking says so, even when a twin that only found it stored first', async () => {
    const [first, second] = [await h.connect(), await h.connect()];
    const args = meeting(await start(22), 'race-key-0006');
    let follower: Booked | undefined;
    twinAnswer = 'after';
    twin = async () => {
      follower = structured<Booked>(await second.callTool({ name: 'book_meeting', arguments: args }));
    };
    const maker = structured<Booked & { next_step: string }>(await first.callTool({ name: 'book_meeting', arguments: args }));
    expect(follower).toMatchObject({ replayed: true, booking: { uid: maker.booking.uid } });
    expect(maker.replayed).toBe(false);
    expect(maker.next_step).toMatch(/^Confirmed/);
  });

  it('when the lookup of the twin\'s booking fails, no refusal is stored or answered (a retry with the key settles it)', async () => {
    const [first, second, third] = [await h.connect(), await h.connect(), await h.connect()];
    const args = meeting(await start(26), 'race-key-0007');
    let winner: Booked | undefined;
    twinAnswer = 'taken';
    twin = async () => {
      winner = structured<Booked>(await second.callTool({ name: 'book_meeting', arguments: args }));
      failNextRead = true;
    };
    const lost = errorText(await first.callTool({ name: 'book_meeting', arguments: args }));
    expect(lost).not.toMatch(/^SLOT_TAKEN/);
    expect(structured<Booked>(await third.callTool({ name: 'book_meeting', arguments: args }))).toMatchObject({ replayed: true, booking: { uid: winner!.booking.uid } });
  });
});
