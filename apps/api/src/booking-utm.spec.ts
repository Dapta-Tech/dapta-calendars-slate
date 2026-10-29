import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, createWebhook, getBookingUtm, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

/**
 * The campaign a booking came from, and the booking's details on the redirect
 * after booking, on the API: the public booking writes (personal and team)
 * keep the five `utm_*` keys, cleaned and never refused, answer them, and hand
 * them to the `booking.created` webhook; the event's redirect carries the event
 * details and the UTMs when the host turns that on, the invitee's name and
 * email only when the host turns that on too, and never the booking's title
 * (a calendar title template can put the invitee's name in it).
 */
describe('UTMs on bookings and booking details on the redirect', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let accountId: string;
  let introId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    accountId = m.account_id;
    const principal: HostPrincipal = { accountId, memberId: m.id, role: 'owner' };
    crud = new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    bookings = new BookingService(db, ENV, calendar, new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
  });

  const span = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });
  const attendee = (email: string) => ({ name: 'Sam Visitor', email, timeZone: 'UTC' });

  async function bookIntro(email: string, utm?: unknown) {
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: attendee(email),
      answers: { company: 'Example Co' },
      ...(utm !== undefined ? { utm } : {}),
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    return out;
  }

  describe('the campaign on the booking', () => {
    it('keeps the five utm_* keys, trimmed, and answers them', async () => {
      const out = await bookIntro('utm@example.org', {
        utm_source: '  google ',
        utm_medium: 'cpc',
        utm_campaign: 'q4 launch',
        utm_term: 'calendar',
        utm_content: 'ad-1',
      });
      const expected = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'q4 launch', utm_term: 'calendar', utm_content: 'ad-1' };
      expect(out.utm).toEqual(expected);
      expect(await getBookingUtm(db, out.uid)).toEqual(expected);
    });

    it('drops other keys, blank, over-long or control-character values, and never refuses the booking for them', async () => {
      const out = await bookIntro('junk@example.org', {
        utm_source: 'newsletter',
        utm_medium: '   ',
        utm_campaign: 'x'.repeat(129),
        utm_term: 'line\nbreak',
        gclid: 'abc',
        evil: '<script>',
      });
      expect(out.utm).toEqual({ utm_source: 'newsletter' });
      const none = await bookIntro('none@example.org', 'not an object');
      expect(none).not.toHaveProperty('utm');
      expect(await getBookingUtm(db, none.uid)).toBeNull();
    });

    it('reads as none on a booking from a page without UTMs, and on every booking made before', async () => {
      const out = await bookIntro('plain@example.org');
      expect(out).not.toHaveProperty('utm');
      expect(await getBookingUtm(db, out.uid)).toBeNull();
    });

    it('a team booking keeps them too', async () => {
      const avail = await bookings.teamAvailability('acme', 'sales', 'team-demo', span().from, span().to);
      const out = await bookings.teamBook('acme', 'sales', {
        slug: 'team-demo',
        startUtc: avail!.slots[0]!.startUtc,
        attendee: attendee('team@example.org'),
        utm: { utm_source: 'linkedin', utm_campaign: 'sales' },
      });
      if ('error' in out) throw new Error(`team book failed: ${out.error}`);
      expect(out.utm).toEqual({ utm_source: 'linkedin', utm_campaign: 'sales' });
      expect(await getBookingUtm(db, out.uid)).toEqual({ utm_source: 'linkedin', utm_campaign: 'sales' });
    });

    it('a second seat on a group booking gets its own campaign back, while the row keeps the first', async () => {
      await crud.updateEventType(REQ, introId, { seatsPerTimeSlot: 3 });
      const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
      const startUtc = avail!.slots[0]!.startUtc;
      const seat = async (email: string, utm: Record<string, string>) => {
        const out = await bookings.book({
          accountCode: 'acme',
          handle: 'alex-rivera',
          slug: 'intro-call',
          startUtc,
          attendee: attendee(email),
          answers: { company: 'Example Co' },
          utm,
        });
        if ('error' in out) throw new Error(`seat failed: ${out.error}`);
        return out;
      };
      const first = await seat('first@example.org', { utm_source: 'google' });
      const second = await seat('second@example.org', { utm_source: 'linkedin' });
      expect(second.uid).toBe(first.uid);
      expect(second.utm).toEqual({ utm_source: 'linkedin' });
      expect(await getBookingUtm(db, first.uid)).toEqual({ utm_source: 'google' });
    });

    it('a retry under the same idempotency key answers the same campaign and redirect, and writes nothing twice', async () => {
      await crud.updateEventType(REQ, introId, { successRedirectUrl: 'https://example.com/thanks', successRedirectData: 'event' });
      const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
      const input = {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: avail!.slots[0]!.startUtc,
        attendee: attendee('retry@example.org'),
        answers: { company: 'Example Co' },
        utm: { utm_source: 'google', utm_campaign: 'q4' },
      };
      const first = await bookings.book(input, false, { idempotencyKey: 'retry-utm-1' });
      const again = await bookings.book(input, false, { idempotencyKey: 'retry-utm-1' });
      if ('error' in first || 'error' in again) throw new Error('book failed');
      expect(again.deduplicated).toBe(true);
      expect(again.uid).toBe(first.uid);
      expect(again.utm).toEqual({ utm_source: 'google', utm_campaign: 'q4' });
      expect(Object.fromEntries(new URL(again.successRedirectUrl!).searchParams)).toMatchObject({ utm_source: 'google', utm_campaign: 'q4' });
      expect(await getBookingUtm(db, first.uid)).toEqual({ utm_source: 'google', utm_campaign: 'q4' });
    });

    it('rides on the booking.created webhook', async () => {
      await createWebhook(db, {
        accountId,
        subscriberUrl: 'https://hooks.example.com/dcal',
        eventTriggers: ['booking.created'],
        key: Buffer.alloc(32, 7),
      });
      const out = await bookIntro('hook@example.org', { utm_source: 'google', utm_campaign: 'q4' });
      // The enqueue runs after the answer; give it its turn.
      let payload: string | null = null;
      for (let i = 0; i < 20 && !payload; i++) {
        await new Promise((r) => setTimeout(r, 10));
        payload = (await db.get<{ payload: string | null }>(
          sql`SELECT payload FROM outbox WHERE booking_uid = ${out.uid} AND kind = 'webhook' LIMIT 1`,
        ))?.payload ?? null;
      }
      expect(payload).not.toBeNull();
      expect(JSON.stringify(JSON.parse(payload!))).toContain('"utm":{"utm_source":"google","utm_campaign":"q4"}');
    });
  });

  describe('the booking details on the redirect after booking', () => {
    const params = (url: string | undefined) => Object.fromEntries(new URL(url!).searchParams);

    it('the editor stores what the redirect carries, reads it back, and clears it on null', async () => {
      const saved = await crud.updateEventType(REQ, introId, { successRedirectUrl: 'https://example.com/thanks', successRedirectData: 'event' });
      expect(saved.successRedirectData).toBe('event');
      expect((await crud.getEventType(REQ, introId)).successRedirectData).toBe('event');
      expect((await crud.updateEventType(REQ, introId, { title: 'Renamed' })).successRedirectData).toBe('event');
      expect((await crud.updateEventType(REQ, introId, { successRedirectData: null })).successRedirectData).toBeNull();
      await expect(crud.updateEventType(REQ, introId, { successRedirectData: 'everything' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('none: the address exactly as typed', async () => {
      await crud.updateEventType(REQ, introId, { successRedirectUrl: 'https://example.com/thanks?from=calendar' });
      const out = await bookIntro('asis@example.org', { utm_source: 'google' });
      expect(out.successRedirectUrl).toBe('https://example.com/thanks?from=calendar');
    });

    it('event: the event, the time, the status, the host and the UTMs, never the invitee or the booking title', async () => {
      await crud.updateEventType(REQ, introId, {
        successRedirectUrl: 'https://example.com/thanks?from=calendar',
        successRedirectData: 'event',
        calendarTitleTemplate: '{{attendee_name}} meets Alex',
      });
      const out = await bookIntro('event@example.org', { utm_source: 'google', utm_campaign: 'q4' });
      const p = params(out.successRedirectUrl);
      expect(p).toMatchObject({
        from: 'calendar',
        event_type: 'intro-call',
        event_start_time: out.startUtc,
        event_end_time: out.endUtc,
        booking_status: out.status,
        utm_source: 'google',
        utm_campaign: 'q4',
      });
      expect(p.event_type_name).toBeTruthy();
      expect(p.assigned_to).toBeTruthy();
      expect(out.successRedirectUrl).not.toContain('Sam');
      expect(out.successRedirectUrl).not.toContain('event%40example.org');
      expect(out.successRedirectUrl).not.toContain(out.uid);
    });

    it('event_and_invitee: adds the invitee’s name and email', async () => {
      await crud.updateEventType(REQ, introId, { successRedirectUrl: 'https://example.com/thanks', successRedirectData: 'event_and_invitee' });
      const out = await bookIntro('invitee@example.org');
      const p = params(out.successRedirectUrl);
      expect(p.invitee_full_name).toBe('Sam Visitor');
      expect(p.invitee_email).toBe('invitee@example.org');
      expect(p).not.toHaveProperty('utm_source');
    });
  });
});
