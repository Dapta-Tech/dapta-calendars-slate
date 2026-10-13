import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, getAvailability, migrate, seed, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';

/**
 * The manage page says who the visitor meets ("With Alex Rivera"). It reads
 * `host.name` from the manage view, which was a constant null, so the page fell
 * back to the attendee's own name: the visitor was told they were meeting
 * themselves. The create response always carried the name; the read-back now
 * says the same thing.
 */
const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

describe('manage view names the host', () => {
  let db: Db;
  let svc: BookingService;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    svc = new BookingService(db, ENV, new CalendarEffects(new DisabledCalendarProvider(), db), email);
  });

  it('carries the host name the create response gave', async () => {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await svc.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: a!.slots[0]!.startUtc,
      attendee: { name: 'Sam Visitor', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.host.name).toBe('Alex Rivera');

    const token = new URL(out.manageUrl!).searchParams.get('token')!;
    const view = await svc.manageView(out.uid, token);
    if ('error' in view) throw new Error(`manage view failed: ${view.error}`);
    expect(view.host).toEqual({ name: 'Alex Rivera', handle: 'alex-rivera' });
    expect(view.attendee.name).toBe('Sam Visitor');
  });
});
