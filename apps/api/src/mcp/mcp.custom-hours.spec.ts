import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, updateEventType } from '@slate/db';
import { bootHarness, structured, type Harness } from './mcp-harness';

/**
 * Custom hours through the MCP slot tool, against the real app: once an event
 * type has its own hours, an agent asking for its slots gets those hours and
 * nothing from the host's working hours. The editor/API rules live in
 * `../event-custom-hours.spec.ts`.
 */

const SCOPES = ['availability:read', 'event-types:read'];
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
/** The seed's host zone. */
const HOST_TZ = 'America/New_York';

type Slot = { start: string; start_utc: string };
type Slots = { days: { slots: Slot[] }[] };

let h: Harness;
let introId: string;

function hostClock(iso: string): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOST_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    time: `${get('hour')}:${get('minute')}`,
  };
}

beforeAll(async () => {
  h = await bootHarness();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  const r = await updateEventType(h.db, h.accountId, introId, {
    customHours: { timeZone: HOST_TZ, ranges: [{ days: [2], start: '10:00', end: '12:00' }] },
  });
  expect(r.ok).toBe(true);
});
afterAll(async () => {
  await h.close();
});

describe('custom hours, through the MCP slot tool', () => {
  it('find_available_slots offers only Tuesdays 10:00-12:00, by page URL and by event type id', async () => {
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const anon = await h.connect();
    const keyed = await h.connect(await h.key(SCOPES));
    for (const [client, args] of [
      [anon, { booking_page_url: PAGE }],
      [keyed, { event_type_id: introId }],
    ] as const) {
      const r = structured<Slots>(
        await client.callTool({ name: 'find_available_slots', arguments: { time_zone: 'UTC', end, ...args } }),
      );
      const slots = r.days.flatMap((d) => d.slots);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        const c = hostClock(s.start_utc);
        expect(c.weekday).toBe(2);
        expect(c.time >= '10:00' && c.time < '12:00').toBe(true);
      }
    }
  });
});
