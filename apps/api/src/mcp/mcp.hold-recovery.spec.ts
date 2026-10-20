import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * hold_slot when something goes wrong between placing the reservation and
 * handing out its hold_id: the binding write fails, or the call times out and
 * the caller retries while the first attempt is still running. Neither may
 * leave the time blocked for ten minutes against the caller's own retry.
 * `bindHold` is wrapped so a test can make it fail once or wait on a gate.
 */
const control = vi.hoisted(() => ({ failNext: false, gate: null as Promise<void> | null }));
vi.mock('./holds', async (importOriginal) => {
  const real = await importOriginal<typeof import('./holds')>();
  return {
    ...real,
    bindHold: async (...args: Parameters<typeof real.bindHold>) => {
      if (control.failNext) {
        control.failNext = false;
        throw new Error('binding write failed');
      }
      if (control.gate) await control.gate;
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
    control.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    try {
      expect(errorText(await c.callTool({ name: 'hold_slot', arguments: args }))).toMatch(/^TIMEOUT/);
      // The first attempt holds the reservation and waits; the retry meets it.
      const early = errorText(await c.callTool({ name: 'hold_slot', arguments: args }));
      expect(early).toMatch(/^INVALID_SLOT/);
      expect(early).toContain('SAME idempotency_key');
    } finally {
      control.gate = null;
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
});
