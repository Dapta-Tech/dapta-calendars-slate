import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseJsonColumn, sql } from '@slate/db';
import { bootHarness, idem, structured, type Harness } from './mcp/mcp-harness';
import { LEGACY_STRINGIFIERS } from './stable-stringify.fixture';

/**
 * The shared `stableStringify` replaced three copies, and only the MCP copy
 * left out a property set to `undefined`. That is the one input on which they
 * disagree, so keeping the MCP variant leaves every stored request hash valid
 * only if the `/v2` callers never hand the serializer such a property. This
 * drives every caller through the real API (the whole `AppModule`, JSON bodies
 * over HTTP, the official MCP client), records each value hashed and the file
 * that hashed it, and checks that:
 *  - a `/v2` value (cal-v2.service.ts, cal-v2-pilot.service.ts) is plain JSON
 *    with no `undefined` property, so every replaced copy gives the same bytes;
 *  - an MCP value (mcp/tools.ts) gives the MCP copy's bytes;
 *  - the hashes the API stored are the ones the replaced copies would have stored.
 */
type Site = keyof typeof LEGACY_STRINGIFIERS;
const hashed = vi.hoisted(() => [] as { site: string; value: unknown }[]);
vi.mock('./stable-stringify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stable-stringify')>();
  return {
    stableStringify: (value: unknown) => {
      // The first frame in the API's own source outside this module is the
      // caller. Separators are normalized so Windows paths match too.
      const frame =
        (new Error().stack ?? '')
          .replace(/\\/g, '/')
          .split('\n')
          .find((line) => /apps\/api\/src\/(?!stable-stringify)/.test(line)) ?? '';
      const site = /cal-v2-pilot\.service\.ts/.test(frame)
        ? 'cal-v2-pilot.service.ts'
        : /cal-v2\.service\.ts/.test(frame)
          ? 'cal-v2.service.ts'
          : /mcp\/tools\.ts/.test(frame)
            ? 'mcp/support.ts'
            : `unknown caller: ${frame.trim()}`;
      hashed.push({ site, value: structuredClone(value) });
      return actual.stableStringify(value);
    },
  };
});

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const TEAM_PAGE = 'https://calendar.example.test/acme/team/sales/team-demo';
const BOOKINGS_VERSION = '2026-02-25';
const GUESTS_VERSION = '2024-08-13';

type Slot = { start: string; start_utc: string };
type Client = Awaited<ReturnType<Harness['connect']>>;

let h: Harness;
let client: Client;
let apiKey: string;
let introId: string;
let teamId: string;

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '200', MCP_RATE_LIMIT_CAPACITY: '500', RATE_LIMIT_ENABLED: 'false' });
  apiKey = await h.key(ALL);
  client = await h.connect(apiKey);
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

/** An open slot right now; asked fresh each time so earlier bookings never collide. */
async function openSlot(page: string, timeZone = 'UTC'): Promise<Slot> {
  const r = structured<{ days: { slots: Slot[] }[] }>(
    await client.callTool({ name: 'find_available_slots', arguments: { booking_page_url: page, time_zone: timeZone } }),
  );
  const slots = r.days.flatMap((d) => d.slots);
  expect(slots.length).toBeGreaterThan(0);
  return slots[0]!;
}

/** A `/v2` call with a JSON body, the way an integration sends it. */
async function v2(path: string, version: string, key: string, body?: unknown): Promise<{ status: number; data: { uid: string } }> {
  const res = await fetch(`${h.base}/v2/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'cal-api-version': version,
      'idempotency-key': key,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data: { uid: string } };
  return { status: res.status, data: json.data };
}

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return structured<T>(await client.callTool({ name, arguments: args }));
}

/** Where a value is not plain JSON: an `undefined` property or element, a hole, a Date or other class, a non-finite number. */
function notPlainJson(value: unknown, path = '$'): string[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path} is ${value}`];
  if (Array.isArray(value))
    return Array.from({ length: value.length }, (_, i) =>
      i in value ? notPlainJson(value[i], `${path}[${i}]`) : [`${path}[${i}] is a hole`],
    ).flat();
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return [`${path} is a ${value.constructor.name}`];
    return Object.entries(value).flatMap(([k, v]) => notPlainJson(v, `${path}.${k}`));
  }
  return [`${path} is ${typeof value}`];
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('every value the real callers hash', () => {
  it('is plain JSON, serializes identically under every replaced copy, and matches the stored hashes', async () => {
    const person = (n: number, timeZone = 'UTC') => ({ name: `Caller ${n}`, email: `caller${n}@example.org`, timeZone });

    // `/v2/bookings` (cal-v2.service.ts): optional fields left out, a team slug
    // selector, and every field the create path accepts.
    const minimal = await v2('bookings', BOOKINGS_VERSION, idem('v2-create-min'), {
      eventTypeId: teamId,
      start: (await openSlot(TEAM_PAGE)).start_utc,
      attendee: person(1),
    });
    expect(minimal.status).toBe(201);
    const bySlug = await v2('bookings', BOOKINGS_VERSION, idem('v2-create-slug'), {
      eventTypeSlug: 'team-demo',
      teamSlug: 'sales',
      start: (await openSlot(TEAM_PAGE)).start_utc,
      attendee: person(2),
      guests: [],
      bookingFieldsResponses: {},
    });
    expect(bySlug.status).toBe(201);
    const full = await v2('bookings', BOOKINGS_VERSION, idem('v2-create-full'), {
      eventTypeId: introId,
      start: (await openSlot(PAGE, 'America/Bogota')).start,
      attendee: { ...person(3, 'America/Bogota'), phoneNumber: '+57 300 000 0000', language: 'es' },
      guests: ['guest.one@example.org', 'Guest.Two@example.org'],
      bookingFieldsResponses: { company: 'Acme "Labs"', topic: 'Pricing\nand API' },
      metadata: { flowRunId: 'run-7', Campaign: 'Q4' },
      lengthInMinutes: 30,
      allowConflicts: false,
      allowBookingOutOfBounds: false,
      skipBookingLimits: false,
      instant: false,
    });
    expect(full.status).toBe(201);

    // A `null` the schema accepts is refused before anything is hashed.
    const before = hashed.length;
    for (const extra of [{ routing: null }, { recurrence: null }, { location: { type: 'address', address: null } }]) {
      const refused = await v2('bookings', BOOKINGS_VERSION, idem('v2-create-null'), {
        eventTypeId: teamId,
        start: (await openSlot(TEAM_PAGE)).start_utc,
        attendee: person(4),
        ...extra,
      });
      expect(refused.status).toBe(422);
    }
    expect(hashed.length).toBe(before);

    // `/v2/bookings/:uid/...` (cal-v2-pilot.service.ts).
    expect((await v2(`bookings/${full.data.uid}/guests`, GUESTS_VERSION, idem('v2-guests'), {
      guests: [{ email: 'new-guest@example.org', name: 'New Guest', timeZone: 'America/Bogota' }, { email: 'NEW-GUEST@example.org' }],
    })).status).toBe(200);
    const moved = await v2(`bookings/${full.data.uid}/reschedule`, BOOKINGS_VERSION, idem('v2-move-1'), {
      start: (await openSlot(PAGE)).start_utc,
    });
    expect(moved.status).toBe(201);
    const movedAgain = await v2(`bookings/${moved.data.uid}/reschedule`, BOOKINGS_VERSION, idem('v2-move-2'), {
      start: (await openSlot(PAGE, 'America/Bogota')).start,
      rescheduledBy: 'host@example.com',
      reschedulingReason: 'Conflict',
    });
    expect(movedAgain.status).toBe(201);
    expect((await v2(`bookings/${movedAgain.data.uid}/cancel`, BOOKINGS_VERSION, idem('v2-cancel-1'))).status).toBe(200);
    expect((await v2(`bookings/${minimal.data.uid}/cancel`, BOOKINGS_VERSION, idem('v2-cancel-2'), {
      cancellationReason: 'Customer asked',
      cancelSubsequentBookings: false,
    })).status).toBe(200);

    // The MCP door: book_meeting (mcp/support.ts), create_booking (cal-v2),
    // reschedule_booking and cancel_booking (pilot), each with and without
    // its optional arguments.
    const attendee = (n: number) => ({ name: `Caller ${n}`, email: `Caller${n}@Example.org`, time_zone: 'America/New_York' });
    await tool('book_meeting', {
      booking_page_url: PAGE,
      start: (await openSlot(PAGE)).start,
      attendee: attendee(5),
      answers: { company: 'Initech', topic: 'Demo' },
      language: 'es',
      idempotency_key: idem('mcp-book-1'),
    });
    await tool('book_meeting', {
      account_code: 'acme',
      team_slug: 'sales',
      event_slug: 'team-demo',
      start: (await openSlot(TEAM_PAGE)).start,
      attendee: attendee(6),
      idempotency_key: idem('mcp-book-2'),
    });
    const created = await tool<{ booking: { uid: string } }>('create_booking', {
      event_type_id: introId,
      start: (await openSlot(PAGE)).start,
      attendee: attendee(7),
      guests: ['extra@example.org'],
      answers: { company: 'Hooli' },
      language: 'es',
      idempotency_key: idem('mcp-create-1'),
    });
    const createdTeam = await tool<{ booking: { uid: string } }>('create_booking', {
      event_type_id: teamId,
      start: (await openSlot(TEAM_PAGE)).start,
      attendee: attendee(8),
      idempotency_key: idem('mcp-create-2'),
    });
    // book_team_meeting by event_type_id books through the same cal-v2 path.
    await tool('book_team_meeting', {
      event_type_id: teamId,
      start: (await openSlot(TEAM_PAGE)).start,
      attendee: attendee(9),
      idempotency_key: idem('mcp-team-1'),
    });
    const toolMoved = await tool<{ booking: { uid: string } }>('reschedule_booking', {
      booking_uid: created.booking.uid,
      start: (await openSlot(PAGE)).start,
      reason: 'Moved by the agent',
      idempotency_key: idem('mcp-move-1'),
    });
    const toolMovedAgain = await tool<{ booking: { uid: string } }>('reschedule_booking', {
      booking_uid: toolMoved.booking.uid,
      start: (await openSlot(PAGE)).start,
      idempotency_key: idem('mcp-move-2'),
    });
    await tool('cancel_booking', { booking_uid: toolMovedAgain.booking.uid, reason: 'Plans changed', idempotency_key: idem('mcp-cancel-1') });
    await tool('cancel_booking', { booking_uid: createdTeam.booking.uid, idempotency_key: idem('mcp-cancel-2') });

    // REST: 3 creates and 5 pilot writes. MCP: 2 book_meeting, plus 2
    // create_booking and 1 book_team_meeting (cal-v2) and 2 + 2
    // reschedule_booking / cancel_booking (pilot).
    const of = (site: Site) => hashed.filter((h) => h.site === site).map((h) => h.value);
    expect(hashed.map((h) => h.site).filter((site) => !(site in LEGACY_STRINGIFIERS))).toEqual([]);
    expect(of('cal-v2.service.ts')).toHaveLength(6);
    expect(of('cal-v2-pilot.service.ts')).toHaveLength(9);
    expect(of('mcp/support.ts')).toHaveLength(2);
    const { stableStringify } = await vi.importActual<typeof import('./stable-stringify')>('./stable-stringify');
    for (const site of ['cal-v2.service.ts', 'cal-v2-pilot.service.ts'] as const)
      for (const value of of(site)) {
        expect(notPlainJson(value), `${site}: ${JSON.stringify(value)}`).toEqual([]);
        for (const [file, legacy] of Object.entries(LEGACY_STRINGIFIERS)) expect(legacy(value), `${site} vs ${file}`).toBe(stableStringify(value));
      }
    // The MCP door does pass `undefined` (book_meeting's `holdId` when no hold
    // is used), which is why its variant is the one kept.
    for (const value of of('mcp/support.ts')) expect(LEGACY_STRINGIFIERS['mcp/support.ts'](value)).toBe(stableStringify(value));
    expect(of('mcp/support.ts').some((value) => notPlainJson(value).some((p) => p.endsWith('is undefined')))).toBe(true);

    // What the API stored is exactly what each replaced copy would have stored.
    const byCopy = (site: Site) => new Set(of(site).map((v) => sha256(LEGACY_STRINGIFIERS[site](v))));
    const records = await h.db.all<{ method: string; path: string; request_hash: string }>(
      sql`SELECT method, path, request_hash FROM api_idempotency`,
    );
    const pilot = records.filter((r) => r.method === 'POST');
    const mcp = records.filter((r) => r.method === 'MCP');
    expect(pilot).toHaveLength(9);
    expect(mcp).toHaveLength(2);
    for (const r of pilot) expect(byCopy('cal-v2-pilot.service.ts').has(r.request_hash), r.path).toBe(true);
    for (const r of mcp) expect(byCopy('mcp/support.ts').has(r.request_hash), r.path).toBe(true);
    const bookings = await h.db.all<{ metadata: unknown }>(sql`SELECT metadata FROM booking WHERE account_id = ${h.accountId}`);
    const createHashes = new Set(
      bookings
        .map((b) => parseJsonColumn<{ _idempotency?: { requestHash?: string } }>(b.metadata, {})._idempotency?.requestHash)
        .filter((x): x is string => !!x),
    );
    expect(createHashes.size).toBe(6);
    for (const stored of createHashes) expect(byCopy('cal-v2.service.ts').has(stored)).toBe(true);
  });
});
