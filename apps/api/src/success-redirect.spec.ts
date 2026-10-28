import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { CalV2Service } from './cal-v2.service';
import { CalV2PilotService } from './cal-v2-pilot.service';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

async function refusalOf(run: Promise<unknown>): Promise<{ error: string; message: string }> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as { error: string; message: string };
  }
  throw new Error('expected the save to be refused');
}

/**
 * Redirect after booking, end to end on the API: the editor's save refuses
 * anything but an https address and stores blank as none; the field is read
 * back where event types are read (`/v1` admin, `/v2`); and the public booking
 * writes (personal and team) answer it to the invitee who booked, while the
 * availability reads anyone can make never carry it.
 */
describe('success redirect URL on event types', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let accountId: string;
  let memberId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    accountId = m.account_id;
    memberId = m.id;
    const principal: HostPrincipal = { accountId, memberId, role: 'owner' };
    crud = new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    bookings = new BookingService(db, ENV, calendar, new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
  });

  const base = { slug: 'thanks', title: 'Thanks call', lengthMinutes: 30 };

  it('stores an https address, trimmed, and reads it back on /v1', async () => {
    const created = await crud.createEventType(REQ, { ...base, successRedirectUrl: '  https://example.com/thanks?x=1  ' });
    expect(created.successRedirectUrl).toBe('https://example.com/thanks?x=1');
    expect((await crud.getEventType(REQ, created.id)).successRedirectUrl).toBe('https://example.com/thanks?x=1');
  });

  it('refuses http, javascript and other schemes on create and on edit, and stores nothing', async () => {
    for (const bad of ['http://example.com/thanks', 'javascript:alert(1)', 'data:text/html,hi', 'example.com/thanks']) {
      const r = await refusalOf(crud.createEventType(REQ, { ...base, slug: `bad-${bad.length}`, successRedirectUrl: bad }));
      expect(r.error).toBe('BAD_REQUEST');
      expect(r.message).toMatch(/https:\/\//);
    }
    const ok = await crud.createEventType(REQ, { ...base, successRedirectUrl: 'https://example.com/a' });
    await refusalOf(crud.updateEventType(REQ, ok.id, { successRedirectUrl: 'javascript:alert(1)' }));
    expect((await crud.getEventType(REQ, ok.id)).successRedirectUrl).toBe('https://example.com/a');
  });

  it('refuses an address longer than the cap', async () => {
    await refusalOf(
      crud.createEventType(REQ, { ...base, successRedirectUrl: `https://example.com/${'a'.repeat(2048)}` }),
    );
  });

  it('keeps it on an edit that omits it, and clears it on null or blank', async () => {
    const ev = await crud.createEventType(REQ, { ...base, successRedirectUrl: 'https://example.com/a' });
    expect((await crud.updateEventType(REQ, ev.id, { title: 'Renamed' })).successRedirectUrl).toBe('https://example.com/a');
    expect((await crud.updateEventType(REQ, ev.id, { successRedirectUrl: '   ' })).successRedirectUrl).toBeNull();
    await crud.updateEventType(REQ, ev.id, { successRedirectUrl: 'https://example.com/b' });
    expect((await crud.updateEventType(REQ, ev.id, { successRedirectUrl: null })).successRedirectUrl).toBeNull();
  });

  it('reads as none on every event type that predates it', async () => {
    const seeded = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!;
    expect((await crud.getEventType(REQ, seeded.id)).successRedirectUrl).toBeNull();
  });

  const span = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });
  const attendee = (email: string) => ({ name: 'Redirect Tester', email, timeZone: 'UTC' });

  it('comes back on the public booking write, and never on the availability read anyone can make', async () => {
    const seeded = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!;
    await crud.updateEventType(REQ, seeded.id, { successRedirectUrl: 'https://example.com/thanks' });
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
    expect(JSON.stringify(avail)).not.toContain('example.com/thanks');
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: attendee('booked@example.org'),
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.successRedirectUrl).toBe('https://example.com/thanks');
  });

  it('is absent from the booking write of an event without one', async () => {
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: attendee('plain@example.org'),
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out).not.toHaveProperty('successRedirectUrl');
  });

  it('comes back on the team booking write too, set from the same editor save', async () => {
    const team = (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!;
    const teamEvent = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE team_id=${team.id}`))!;
    await crud.updateEventType(REQ, teamEvent.id, { successRedirectUrl: 'https://example.com/team' });
    const avail = await bookings.teamAvailability('acme', 'sales', 'team-demo', span().from, span().to);
    expect(JSON.stringify(avail)).not.toContain('example.com/team');
    const out = await bookings.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: attendee('team-booked@example.org'),
    });
    if ('error' in out) throw new Error(`team book failed: ${out.error}`);
    expect(out.successRedirectUrl).toBe('https://example.com/team');
  });

  it('is listed on /v2 event types under the cal.com name', async () => {
    await crud.createEventType(REQ, { ...base, successRedirectUrl: 'https://example.com/v2' });
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const pilot = new CalV2PilotService(db, calendar, bookings, new CalV2Service(bookings, db));
    const rows = await pilot.eventTypes(accountId, {});
    expect(rows.find((r) => r.slug === 'thanks')?.successRedirectUrl).toBe('https://example.com/v2');
    expect(rows.find((r) => r.slug === 'intro-call')?.successRedirectUrl).toBeNull();
  });
});
