import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@slate/db';
import { bootHarness, structured, type Harness } from './mcp-harness';
import { TOOLS, type ToolResult } from './tools';

/**
 * Output schemas stay open to fields added later. A client validates every
 * result against the output schema it read when it listed the tools, so a
 * session opened before a deploy keeps the old schema; a closed object there
 * (`additionalProperties: false`) makes every call fail once the server adds a
 * field: "Structured content does not match the tool's output schema".
 */

let h: Harness;
beforeAll(async () => {
  h = await bootHarness({ MCP_RATE_LIMIT_CAPACITY: '200' });
});
afterAll(async () => {
  await h.close();
});

/** Every place in a JSON Schema that closes an object to new properties. */
function closedObjects(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) return schema.flatMap((s, i) => closedObjects(s, `${path}[${i}]`));
  const node = schema as Record<string, unknown>;
  const here = node['additionalProperties'] === false || node['unevaluatedProperties'] === false ? [path] : [];
  return [...here, ...Object.entries(node).flatMap(([k, v]) => closedObjects(v, `${path}.${k}`))];
}

describe('output schemas a session keeps across deploys', () => {
  it('never close an object, on any tool', async () => {
    const c = await h.connect(await h.key(['bookings:read']));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const closed = tools.flatMap((t) => closedObjects(t.outputSchema).map((p) => `${t.name} ${p}`));
    expect(closed).toEqual([]);
  });

  it('accept a get_booking result carrying fields added after the session listed the tools', async () => {
    const uid = await h.newBooking();
    const booking = (await h.db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!;
    await h.db.run(
      sql`INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, created_at)
          VALUES (${randomUUID()}, ${booking.id}, 'Ana Guest', 'ana@example.com', 'UTC', ${Date.now()})`,
    );
    // The old session: it lists the tools, and with them the output schemas, now.
    const c = await h.connect(await h.key(['bookings:read']));
    await c.listTools();

    // Then the server learns new fields, at every level of the result.
    const def = TOOLS.find((t) => t.name === 'get_booking')!;
    const run = def.run.bind(def);
    const spy = vi.spyOn(def, 'run').mockImplementation(async (...args: Parameters<typeof def.run>): Promise<ToolResult> => {
      const r = await run(...args);
      const d = r.data as { booking: object; invitee_supplied: { attendees: object[] } };
      return {
        ...r,
        data: {
          ...d,
          added_later: 'root',
          booking: { ...d.booking, added_later: 'booking' },
          invitee_supplied: {
            ...d.invitee_supplied,
            added_later: 'invitee_supplied',
            attendees: d.invitee_supplied.attendees.map((a) => ({ ...a, added_later: 'attendee' })),
          },
        },
      };
    });
    try {
      const got = structured<{
        added_later: string;
        booking: { uid: string; added_later: string };
        invitee_supplied: { added_later: string; attendees: { name: string; added_later: string }[] };
      }>(await c.callTool({ name: 'get_booking', arguments: { booking_uid: uid } }));
      expect(got.booking.uid).toBe(uid);
      expect(got.added_later).toBe('root');
      expect(got.booking.added_later).toBe('booking');
      expect(got.invitee_supplied.added_later).toBe('invitee_supplied');
      expect(got.invitee_supplied.attendees[0]).toMatchObject({ name: 'Ana Guest', added_later: 'attendee' });
    } finally {
      spy.mockRestore();
    }
  });
});
