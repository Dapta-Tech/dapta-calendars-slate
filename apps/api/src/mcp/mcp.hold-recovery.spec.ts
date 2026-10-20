import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@slate/db';
import { BookingService } from '../booking.service';
import { CalV2PilotService } from '../cal-v2-pilot.service';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * hold_slot when something goes wrong between placing the reservation and
 * handing out its hold_id: the binding write fails, or the call times out and
 * the caller retries while the first attempt is still running. Neither may
 * leave the time blocked for ten minutes against the caller's own retry.
 * `bindHold` is wrapped so a test can make it fail once, or make the next calls
 * wait on gates, one gate per call in order.
 */
const control = vi.hoisted(() => ({ failNext: false, gates: [] as Array<Promise<void>>, loseSavedReply: false }));
// A keyed write's result record (status 200) that commits, then loses its reply.
vi.mock('@slate/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slate/db')>();
  return {
    ...real,
    completeApiIdempotency: async (...args: Parameters<typeof real.completeApiIdempotency>) => {
      const written = await real.completeApiIdempotency(...args);
      if (control.loseSavedReply && args[2] === 200) {
        control.loseSavedReply = false;
        throw new Error('connection reset after commit');
      }
      return written;
    },
  };
});
vi.mock('./holds', async (importOriginal) => {
  const real = await importOriginal<typeof import('./holds')>();
  return {
    ...real,
    bindHold: async (...args: Parameters<typeof real.bindHold>) => {
      if (control.failNext) {
        control.failNext = false;
        throw new Error('binding write failed');
      }
      const gate = control.gates.shift();
      if (gate) await gate;
      return real.bindHold(...args);
    },
  };
});

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
type Hold = { hold: { hold_id: string; start_utc: string }; replayed: boolean };

let h: Harness;
let introId: string;
beforeAll(async () => {
  // The shortest timeout the server allows, so a gated hold times out quickly.
  h = await bootHarness({ MCP_TOOL_TIMEOUT_MS: '1000', MCP_WRITE_RATE_LIMIT_CAPACITY: '100' });
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const openClaims = async () =>
  Number((await h.db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM api_idempotency WHERE path = 'hold_slot' AND status_code IS NULL`))!.n);

const heldAt = async (startUtc: string) =>
  Number((await h.db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE slot_start_ms = ${Date.parse(startUtc)}`))!.n);

async function slot(client: Awaited<ReturnType<Harness['connect']>>, nth: number) {
  const r = structured<{ days: { slots: { start: string; start_utc: string }[] }[] }>(
    await client.callTool({ name: 'find_available_slots', arguments: { event_type_id: introId, time_zone: 'UTC' } }),
  );
  return r.days.flatMap((d) => d.slots)[nth]!;
}

describe('hold_slot recovery', () => {
  it('a hold whose binding cannot be written gives its reservation back, and the same key then holds the time', async () => {
    const c = await h.connect(await h.key(ALL));
    const s = await slot(c, 4);
    const args = { event_type_id: introId, start: s.start, time_zone: 'UTC', idempotency_key: idem('recover-fail-0001') };
    control.failNext = true;
    expect(errorText(await c.callTool({ name: 'hold_slot', arguments: args }))).toMatch(/^INTERNAL_ERROR/);
    expect(await heldAt(s.start_utc)).toBe(0);
    const retried = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: args }));
    expect(retried.replayed).toBe(false);
    expect(retried.hold.start_utc).toBe(s.start_utc);
    expect(await heldAt(s.start_utc)).toBe(1);
  });

  it('a retry while a timed-out hold is still running says to retry with the same key, and then gets that very hold', async () => {
    const c = await h.connect(await h.key(ALL));
    const s = await slot(c, 8);
    const args = { event_type_id: introId, start: s.start, time_zone: 'UTC', idempotency_key: idem('recover-slow-0001') };
    let open!: () => void;
    control.gates.push(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    try {
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: args }))).toMatch(/^TIMEOUT/);
      // The first attempt holds the reservation and waits; the retry meets it.
      const early = errorText(await c.callTool({ name: 'hold_slot', arguments: args }));
      expect(early).toMatch(/^INVALID_SLOT/);
      expect(early).toContain('SAME idempotency_key');
    } finally {
      control.gates.length = 0;
      open();
    }
    let replay: Hold | undefined;
    for (let i = 0; i < 50 && !replay; i += 1) {
      const r = await c.callTool({ name: 'hold_slot', arguments: args });
      if (!r.isError) replay = structured<Hold>(r);
      else await new Promise((done) => setTimeout(done, 20));
    }
    expect(replay).toMatchObject({ replayed: true, hold: { start_utc: s.start_utc } });
    expect(await heldAt(s.start_utc)).toBe(1);
    // That hold_id books the time.
    const booked = structured<{ booking: { start_utc: string } }>(
      await c.callTool({
        name: 'create_booking',
        arguments: {
          event_type_id: introId,
          start: s.start,
          attendee: { name: 'Slow Holder', email: 'slow.holder@example.org', time_zone: 'UTC' },
          answers: { company: 'S' },
          hold_id: replay!.hold.hold_id,
          idempotency_key: idem('recover-slow-0002'),
        },
      }),
    );
    expect(booked.booking.start_utc).toBe(s.start_utc);
  });

  it('a refused attempt leaves no open claim, so a retry with the same key gets the plain refusal, not "still running"', async () => {
    const c = await h.connect(await h.key(ALL));
    const s1 = await slot(c, 12);
    // Somebody else holds the time.
    structured(await (await h.connect()).callTool({ name: 'hold_slot', arguments: { booking_page_url: PAGE, start: s1.start, time_zone: 'UTC', idempotency_key: idem('recover-other-001') } }));
    const args = { event_type_id: introId, start: s1.start, time_zone: 'UTC', idempotency_key: idem('recover-refused-01') };
    for (let i = 0; i < 2; i += 1) {
      const text = errorText(await c.callTool({ name: 'hold_slot', arguments: args }));
      expect(text).toMatch(/^INVALID_SLOT/);
      expect(text).not.toContain('SAME idempotency_key');
    }
    expect(await openClaims()).toBe(0);
  });

  /** Retry until the first attempt's stored hold comes back (it finishes in the background). */
  async function replayOf(c: Awaited<ReturnType<Harness['connect']>>, args: Record<string, unknown>): Promise<Hold | undefined> {
    for (let i = 0; i < 50; i += 1) {
      const r = await c.callTool({ name: 'hold_slot', arguments: args });
      if (!r.isError) return structured<Hold>(r);
      await new Promise((done) => setTimeout(done, 20));
    }
    return undefined;
  }

  it('a retry never removes a running attempt\'s record, however old it looks: the first attempt\'s hold is kept and replayed', async () => {
    const c = await h.connect(await h.key(ALL));
    const s1 = await slot(c, 16);
    const args = { event_type_id: introId, start: s1.start, time_zone: 'UTC', idempotency_key: idem('recover-stale-001') };
    let open!: () => void;
    control.gates.push(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    try {
      // A: reserves, then waits on the gate past its timeout.
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: args }))).toMatch(/^TIMEOUT/);
      // As if A had started an hour ago, or on a pod with a skewed clock.
      await h.db.run(sql`UPDATE api_idempotency SET created_at = created_at - ${3_600_000} WHERE path = 'hold_slot' AND status_code IS NULL`);
      // B: meets A's reservation, is refused, and leaves A's record alone.
      const text = errorText(await c.callTool({ name: 'hold_slot', arguments: args }));
      expect(text).toMatch(/^INVALID_SLOT/);
      expect(text).toContain('SAME idempotency_key');
      expect(await openClaims()).toBe(1);
    } finally {
      control.gates.length = 0;
      open();
    }
    // A completes; C gets A's hold, and it books.
    const replay = await replayOf(c, args);
    expect(replay).toMatchObject({ replayed: true, hold: { start_utc: s1.start_utc } });
    expect(await heldAt(s1.start_utc)).toBe(1);
    const booked = structured<{ booking: { start_utc: string } }>(
      await c.callTool({
        name: 'create_booking',
        arguments: {
          event_type_id: introId,
          start: s1.start,
          attendee: { name: 'Kept Record', email: 'kept.record@example.org', time_zone: 'UTC' },
          answers: { company: 'K' },
          hold_id: replay!.hold.hold_id,
          idempotency_key: idem('recover-stale-002'),
        },
      }),
    );
    expect(booked.booking.start_utc).toBe(s1.start_utc);
  });

  it('a result whose record vanished meanwhile is stored again, never lost', async () => {
    const c = await h.connect(await h.key(ALL));
    const s1 = await slot(c, 18);
    const args = { event_type_id: introId, start: s1.start, time_zone: 'UTC', idempotency_key: idem('recover-gone-0001') };
    let open!: () => void;
    control.gates.push(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    try {
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: args }))).toMatch(/^TIMEOUT/);
      // The open record disappears (swept, or removed) while A still runs.
      await h.db.run(sql`DELETE FROM api_idempotency WHERE path = 'hold_slot' AND status_code IS NULL`);
    } finally {
      control.gates.length = 0;
      open();
    }
    // A's store writes no row, so it opens the record again and stores there.
    const replay = await replayOf(c, args);
    expect(replay).toMatchObject({ replayed: true, hold: { start_utc: s1.start_utc } });
    expect(await heldAt(s1.start_utc)).toBe(1);
  });

  it('a result never lands on a record a call with other arguments opened: that call keeps its own answer', async () => {
    const c = await h.connect(await h.key(ALL));
    const [early, late] = [await slot(c, 22), await slot(c, 26)];
    const ask = (at: { start: string }) => ({ event_type_id: introId, start: at.start, time_zone: 'UTC', idempotency_key: idem('recover-swap-0001') });
    let openA!: () => void;
    let openB!: () => void;
    control.gates.push(
      new Promise<void>((resolve) => {
        openA = resolve;
      }),
      new Promise<void>((resolve) => {
        openB = resolve;
      }),
    );
    try {
      // A asks for the early time and stalls past its timeout.
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: ask(early) }))).toMatch(/^TIMEOUT/);
      // A's record vanishes; B, the same key with other arguments, opens a new one and stalls too.
      await h.db.run(sql`DELETE FROM api_idempotency WHERE path = 'hold_slot' AND status_code IS NULL`);
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: ask(late) }))).toMatch(/^TIMEOUT/);
      // A finishes while B's record is open: it must not store its result there, and gives its hold back.
      openA();
      for (let i = 0; i < 50 && (await heldAt(early.start_utc)) > 0; i += 1) await new Promise((done) => setTimeout(done, 20));
    } finally {
      control.gates.length = 0;
      openA();
      openB();
    }
    expect(await heldAt(early.start_utc)).toBe(0);
    // B finishes, and the key answers B's own time; A's arguments are refused.
    const replay = await replayOf(c, ask(late));
    expect(replay).toMatchObject({ replayed: true, hold: { start_utc: late.start_utc } });
    expect(errorText(await c.callTool({ name: 'hold_slot', arguments: ask(early) }))).toContain('IDEMPOTENCY_KEY_REUSED');
  });

  it('a result that was saved but whose reply was lost is kept: the hold stands and books', async () => {
    const c = await h.connect(await h.key(ALL));
    const s1 = await slot(c, 20);
    const args = { event_type_id: introId, start: s1.start, time_zone: 'UTC', idempotency_key: idem('recover-lost-0001') };
    control.loseSavedReply = true;
    const first = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: args }));
    expect(await heldAt(s1.start_utc)).toBe(1);
    const replay = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: args }));
    expect(replay).toMatchObject({ replayed: true, hold: { hold_id: first.hold.hold_id } });
    const booked = structured<{ booking: { start_utc: string } }>(
      await c.callTool({
        name: 'create_booking',
        arguments: {
          event_type_id: introId,
          start: s1.start,
          attendee: { name: 'Lost Reply', email: 'lost.reply@example.org', time_zone: 'UTC' },
          answers: { company: 'L' },
          hold_id: first.hold.hold_id,
          idempotency_key: idem('recover-lost-0002'),
        },
      }),
    );
    expect(booked.booking.start_utc).toBe(s1.start_utc);
  });
});

describe('the MCP booking writes count holds under the lock', () => {
  it('book_meeting and create_booking ask the core for refuseHeld, and reschedule_booking too', async () => {
    const book = vi.spyOn(BookingService.prototype, 'book');
    const move = vi.spyOn(CalV2PilotService.prototype, 'reschedule');
    try {
      const anon = await h.connect();
      const c = await h.connect(await h.key(ALL));
      const [a, b, m] = [await slot(c, 24), await slot(c, 26), await slot(c, 28)];
      const who = (name: string) => ({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.org`, time_zone: 'UTC' });
      structured(await anon.callTool({ name: 'book_meeting', arguments: { booking_page_url: PAGE, start: a.start, attendee: who('Page Lock'), answers: { company: 'P' }, idempotency_key: idem('lock-page-00001') } }));
      const made = structured<{ booking: { uid: string } }>(
        await c.callTool({ name: 'create_booking', arguments: { event_type_id: introId, start: b.start, attendee: who('Key Lock'), answers: { company: 'K' }, idempotency_key: idem('lock-key-000001') } }),
      );
      expect(book.mock.calls.map((call) => call[2]?.refuseHeld)).toEqual([true, true]);
      structured(await c.callTool({ name: 'reschedule_booking', arguments: { booking_uid: made.booking.uid, start: m.start, idempotency_key: idem('lock-move-00001') } }));
      expect(move.mock.calls.map((call) => call[6])).toEqual([{ refuseHeld: true }]);
    } finally {
      book.mockRestore();
      move.mockRestore();
    }
  });
});
