import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, getBookingUtm, migrate, seed, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import type { BookingUtm } from '@slate/types';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import type { CrmEffects } from './crm-effects';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const DAY = 86_400_000;

/**
 * The CRM write-out reads the booking's campaign (`booking.utm`) when it runs,
 * for the meeting body and for `kind: 'utm'` mappings. So the campaign must be
 * on the booking before the write-out is queued, on the personal path and on
 * the team path alike: a write-out queued first could run before the campaign
 * lands and deliver none.
 */
describe('the campaign is on the booking before its CRM write-out is queued', () => {
  let db: Db;
  let bookings: BookingService;
  /** What the booking held at the moment each write-out was queued. */
  let seen: Promise<BookingUtm | null>[];

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    seen = [];
    // Reads the row at the moment the write-out is queued, the earliest any
    // worker could pick it up.
    const crm = {
      onBookingAccepted: (uid: string) => seen.push(getBookingUtm(db, uid)),
      onBookingCancelled: () => undefined,
      onBookingRescheduled: () => undefined,
    } as unknown as CrmEffects;
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    bookings = new BookingService(db, ENV, calendar, new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db), crm);
  });

  afterEach(async () => {
    await db.close();
  });

  const span = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });

  it('on a personal booking', async () => {
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: { name: 'Sam Visitor', email: 'personal@example.org', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
      utm: { utm_source: 'newsletter' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(await Promise.all(seen)).toEqual([{ utm_source: 'newsletter' }]);
  });

  it('on a team booking', async () => {
    const avail = await bookings.teamAvailability('acme', 'sales', 'team-demo', span().from, span().to);
    const out = await bookings.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: { name: 'Sam Visitor', email: 'team@example.org', timeZone: 'UTC' },
      utm: { utm_source: 'linkedin', utm_campaign: 'sales' },
    });
    if ('error' in out) throw new Error(`team book failed: ${out.error}`);
    expect(await Promise.all(seen)).toEqual([{ utm_source: 'linkedin', utm_campaign: 'sales' }]);
  });
});
