import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { AdminCrudController } from './admin-crud.controller';
import type { AnalyticsEffects } from './analytics-effects';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

/**
 * POST and PATCH /v1/event-types as the dashboard sees them, pinned before
 * their checks and write moved to `event-type-write.ts` (shared with the MCP
 * tools): who may write what, the refusals in the order a save meets them, and
 * which save counts as a publish. The behaviour must not change.
 */

const WEB: ReqLike = { headers: { 'x-slate-client': 'web' } };
let db: Db;
let principal: HostPrincipal;
let hostEvent: ReturnType<typeof vi.fn>;
let crud: AdminCrudController;
let ids: { alex: string; jordan: string; intro: string; team: string; acme: string };
const status = (run: Promise<unknown>) => run.then(() => 200, (e: { getStatus(): number; getResponse(): unknown }) => [e.getStatus(), e.getResponse()]);

beforeEach(async () => {
  db = await createDb('file::memory:');
  await migrate(db);
  await seed(db);
  const one = async (q: ReturnType<typeof sql>) => (await db.get<{ id: string }>(q))!.id;
  ids = {
    acme: await one(sql`SELECT id FROM account WHERE code = 'acme'`),
    alex: await one(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`),
    jordan: await one(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`),
    intro: await one(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`),
    team: await one(sql`SELECT id FROM event_type WHERE slug = 'team-demo'`),
  };
  principal = { accountId: ids.acme, memberId: ids.alex, role: 'owner' };
  hostEvent = vi.fn(() => Promise.resolve());
  const auth = { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService;
  crud = new AdminCrudController(db, auth, undefined, undefined, { hostEvent } as unknown as AnalyticsEffects);
});

describe('the dashboard writes an event type', () => {
  it('creates for the caller, keeps team ones for admins, and refuses a clash or two sources of hours', async () => {
    const created = (await crud.createEventType(WEB, { slug: 'demo', title: 'Demo', lengthMinutes: 30 })) as { memberId: string };
    expect(created.memberId).toBe(ids.alex);
    expect(await status(crud.createEventType(WEB, { slug: 'demo', title: 'Again', lengthMinutes: 30 }))).toEqual([409, { error: 'SLUG_TAKEN', message: 'That slug is already in use.' }]);
    const hours = { timeZone: 'UTC', ranges: [{ days: [1], start: '09:00', end: '10:00' }] };
    expect(await status(crud.createEventType(WEB, { slug: 'both', title: 'B', lengthMinutes: 30, customHours: hours, scheduleId: null }))).toEqual([
      400,
      { error: 'BAD_REQUEST', message: 'Send customHours or scheduleId, not both.' },
    ]);
    principal = { accountId: ids.acme, memberId: ids.jordan, role: 'member' };
    expect((await status(crud.createEventType(WEB, { slug: 't', title: 'T', lengthMinutes: 30, teamId: 'any' })) as [number])[0]).toBe(403);
  });

  it('changes only what the caller may manage, in its own account, under the same checks', async () => {
    expect((await status(crud.updateEventType(WEB, 'not-here', { title: 'X' })) as [number])[0]).toBe(404);
    expect(await status(crud.updateEventType(WEB, ids.team, { customHours: { timeZone: 'UTC', ranges: [{ days: [1], start: '09:00', end: '10:00' }] } }))).toEqual([
      400,
      { error: 'BAD_REQUEST', message: 'Custom hours are for personal event types; team hosts follow their own schedules.' },
    ]);
    expect(await status(crud.updateEventType(WEB, ids.intro, { tracking: { ga4Id: 'G-ABC123' } }))).toMatchObject([400, { error: 'TRACKING_DISABLED' }]);
    principal = { accountId: ids.acme, memberId: ids.jordan, role: 'member' };
    expect((await status(crud.updateEventType(WEB, ids.intro, { title: 'Mine now' })) as [number])[0]).toBe(403);
    principal = { accountId: ids.acme, memberId: ids.alex, role: 'owner' };
    expect(await crud.updateEventType(WEB, ids.intro, { title: 'Renamed' })).toMatchObject({ id: ids.intro, title: 'Renamed' });
  });

  it('counts a publish only for the save that makes an event type visible, by where the call came from', async () => {
    const hidden = (await crud.createEventType(WEB, { slug: 'later', title: 'Later', lengthMinutes: 30, hidden: true })) as { id: string };
    await crud.updateEventType(WEB, hidden.id, { title: 'Later, renamed' });
    await crud.updateEventType({ headers: {} }, hidden.id, { hidden: false });
    await crud.updateEventType(WEB, hidden.id, { hidden: false });
    expect(hostEvent.mock.calls.map((c) => [c[0], (c[2] as { source: string }).source])).toEqual([['event_type_published', 'api']]);
  });
});
