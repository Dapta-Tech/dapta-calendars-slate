import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { bookingHostIsSeparate, publicBookingBase } from './booking-origin';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { trackingAllowedFor } from './event-tracking-gate';

const SEPARATE = loadServerEnv({
  NODE_ENV: 'test',
  PUBLIC_APP_URL: 'https://app.example.com',
  PUBLIC_BOOKING_URL: 'https://book.example.com/',
} as NodeJS.ProcessEnv);
const SINGLE = loadServerEnv({ NODE_ENV: 'test', PUBLIC_APP_URL: 'https://app.example.com' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

/**
 * Booking pages on a host of their own, on the API: the links it writes for
 * invitees (the manage link on every booking, in its emails) name the booking
 * host, and once that host is apart from the dashboard every workspace may load
 * Google Tag Manager, Google Analytics and HubSpot, with no allowlist.
 */
describe('a booking host of its own', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let introId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`))!;
    accountId = m.account_id;
    memberId = m.id;
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
  });

  const service = (env = SEPARATE) =>
    new BookingService(db, env, new CalendarEffects(new DisabledCalendarProvider(), db), new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
  const controller = (env = SEPARATE) => {
    const principal: HostPrincipal = { accountId, memberId, role: 'owner' };
    return new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService, undefined, undefined, undefined, undefined, env);
  };

  it('names the booking host, or the app host when there is none', () => {
    expect(publicBookingBase(SEPARATE)).toBe('https://book.example.com');
    expect(publicBookingBase(SINGLE)).toBe('https://app.example.com');
    // The origin only: a path on the setting names pages the web never serves.
    expect(publicBookingBase({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'https://book.example.com/x?y=1' })).toBe('https://book.example.com');
    expect(bookingHostIsSeparate(SEPARATE)).toBe(true);
    expect(bookingHostIsSeparate(SINGLE)).toBe(false);
    expect(bookingHostIsSeparate({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'https://app.example.com/' })).toBe(false);
    // Only an http(s) address names a host, as the web reads it.
    expect(bookingHostIsSeparate({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'ftp://book.example.com' })).toBe(false);
    expect(publicBookingBase({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'ftp://book.example.com' })).toBe('https://app.example.com');
  });

  it('the manage link a booking answers (and its emails carry) is on the booking host', async () => {
    const bookings = service();
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * DAY).toISOString();
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: { name: 'Sam', email: 'sam@example.org', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.manageUrl).toMatch(/^https:\/\/book\.example\.com\/manage\//);
  });

  it('every workspace may load GTM, GA4 and HubSpot once the booking host is apart, with no allowlist', async () => {
    expect(trackingAllowedFor(SEPARATE, { code: 'anyone' })).toBe(true);
    expect(trackingAllowedFor(SINGLE, { code: 'anyone' })).toBe(false);
    const crud = controller();
    const saved = await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-ABC1234', hubspotTrackingId: '1357' } });
    expect(saved.tracking).toEqual({ gtmId: 'GTM-ABC1234', hubspotTrackingId: '1357' });
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * DAY).toISOString();
    const avail = await service().availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to });
    expect(avail!.eventType.tracking).toEqual({ gtmId: 'GTM-ABC1234', hubspotTrackingId: '1357' });
    // With the only origin the page may start them on, so a web without its own setting fails closed.
    expect(avail!.eventType.trackingHostScriptsOrigin).toBe('https://book.example.com');
    const listed = (await service().profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!;
    expect(listed.trackingHostScriptsOrigin).toBe('https://book.example.com');
    // On one origin they stay behind the allowlist, as before.
    expect((await service(SINGLE).availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to }))!.eventType.tracking).toBeUndefined();
  });
});
