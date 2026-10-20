import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingService } from '../booking.service';
import { bootHarness, idem, structured, type Harness } from './mcp-harness';

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
type Booked = { booking: { uid: string; status: string; start_utc: string }; replayed: boolean };

let h: Harness;
const realBook = BookingService.prototype.book;
let twin: (() => Promise<void>) | null = null;
let twinAnswer: 'taken' | 'real' = 'taken';
const book = vi.spyOn(BookingService.prototype, 'book').mockImplementation(async function (this: BookingService, ...args: Parameters<BookingService['book']>) {
  if (twin) {
    const run = twin;
    twin = null;
    await run();
    if (twinAnswer === 'taken') return { error: 'SLOT_TAKEN', message: 'That time is no longer available.', status: 409 };
  }
  return realBook.apply(this, args);
});

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '100', MCP_RATE_LIMIT_CAPACITY: '200' });
});
afterAll(async () => {
  book.mockRestore();
  await h.close();
});
afterEach(() => {
  twin = null;
  writes.book_meeting = 0;
});

async function start(nth: number): Promise<string> {
  const c = await h.connect();
  const r = structured<{ days: { slots: { start: string }[] }[] }>(
    await c.callTool({ name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } }),
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
});
