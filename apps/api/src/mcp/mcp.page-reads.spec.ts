import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, upsertAccountBranding } from '@slate/db';
import { bootHarness, errorText, structured, type Harness } from './mcp-harness';

/**
 * The booking page and calendar reads: list_calendar_connections (the
 * Calendars screen), get_brand_kit and get_booking_page_settings (the brand
 * kit, the link name and the branding switch). Account-wide, tenant-bound.
 */

type Connection = {
  id: string;
  member_id: string;
  provider: string;
  email: string | null;
  checks_conflicts: boolean;
  is_destination: boolean;
  last_check: { at: string; ok: boolean | null; detail: string | null } | null;
};

let h: Harness;

beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h.close();
});

async function connect(accountId: string, opts: { email: string; ok?: boolean; destination?: boolean }) {
  const member = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${accountId} ORDER BY created_at ASC LIMIT 1`))!;
  const id = randomUUID();
  const checkedAt = opts.ok === undefined ? null : Date.now() - 60_000;
  await h.db.run(
    sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts,
          last_check_at, last_check_ok, last_check_detail, created_at)
        VALUES (${id}, ${accountId}, ${member.id}, 'google', ${`ext-${id}`}, ${opts.email}, ${opts.destination ? 1 : 0}, 1,
          ${checkedAt}, ${opts.ok === undefined ? null : opts.ok ? 1 : 0}, ${opts.ok === false ? 'Token expired' : null}, ${Date.now()})`,
  );
  return { id, memberId: member.id };
}

describe('list_calendar_connections', () => {
  it("lists the account's connections with their role and last check, never the provider reference", async () => {
    const good = await connect(h.accountId, { email: 'host@example.org', ok: true, destination: true });
    const bad = await connect(h.accountId, { email: 'old@example.org', ok: false });
    const theirs = await connect(h.other.accountId, { email: 'other@example.org' });
    const c = await h.connect(await h.key(['availability:read']));
    const raw = await c.callTool({ name: 'list_calendar_connections', arguments: {} });
    const got = structured<{ connections: Connection[]; count: number }>(raw);
    const ids = got.connections.map((x) => x.id);
    expect(ids).toContain(good.id);
    expect(ids).toContain(bad.id);
    expect(ids).not.toContain(theirs.id);
    expect(got.connections.find((x) => x.id === good.id)).toMatchObject({
      member_id: good.memberId,
      provider: 'google',
      email: 'host@example.org',
      checks_conflicts: true,
      is_destination: true,
      last_check: { ok: true, detail: null },
    });
    expect(got.connections.find((x) => x.id === bad.id)!.last_check).toMatchObject({ ok: false, detail: 'Token expired' });
    expect(JSON.stringify(raw)).not.toContain(`ext-${good.id}`);
  });

  it('needs availability:read', async () => {
    const none = await h.connect(await h.key(['bookings:read', 'calendars:read']));
    expect(errorText(await none.callTool({ name: 'list_calendar_connections', arguments: {} }))).toContain('INSUFFICIENT_SCOPE');
  });
});

describe('get_brand_kit', () => {
  it('reads the kit, and reports an inline logo as set without its bytes', async () => {
    const c = await h.connect(await h.key(['event-types:read']));
    await upsertAccountBranding(h.db, h.accountId, { accent: '#112233', theme: 'dark', logoUrl: `data:image/png;base64,${'A'.repeat(2000)}` });
    const raw = await c.callTool({ name: 'get_brand_kit', arguments: {} });
    const got = structured<{ brand_kit: Record<string, unknown> | null; updated_at: string | null }>(raw);
    expect(got.brand_kit).toMatchObject({ accent: '#112233', theme: 'dark', logo_url: '(inline image)' });
    expect(got.updated_at).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('AAAAAAAAAA');
  });

  it('reads no kit as null', async () => {
    const c = await h.connect(await h.key(['event-types:read']));
    await upsertAccountBranding(h.db, h.accountId, {});
    expect(structured<{ brand_kit: unknown }>(await c.callTool({ name: 'get_brand_kit', arguments: {} })).brand_kit).toBeNull();
  });
});

describe('get_booking_page_settings', () => {
  it('names the code the links start with, as whoami does, and the branding state', async () => {
    const c = await h.connect(await h.key(['event-types:read']));
    const got = structured<{ link: { code: string; vanity_slug: string | null; short_code: string }; branding: Record<string, boolean> }>(
      await c.callTool({ name: 'get_booking_page_settings', arguments: {} }),
    );
    const me = structured<{ account: { code: string } }>(await c.callTool({ name: 'whoami', arguments: {} }));
    expect(got.link.code).toBe(me.account.code);
    expect(got.link.code).toBe(got.link.vanity_slug ?? got.link.short_code);
    for (const k of ['showing', 'hidden_by_choice', 'can_hide']) expect(typeof got.branding[k]).toBe('boolean');
  });
});
