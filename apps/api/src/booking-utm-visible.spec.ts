import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApiKey, createDb, createWebhook, migrate, seed, setBookingUtm, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import { AdminService } from './admin.service';
import type { AuthProvider } from './auth.provider';
import { AuthService, type HostPrincipal, type ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CAL_V2_BOOKINGS_VERSION, CalV2Controller } from './cal-v2.controller';
import { CalV2PilotService } from './cal-v2-pilot.service';
import { CalV2Service } from './cal-v2.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { HostController } from './host.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;
const CAMPAIGN = { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'q4 launch' };
const HOOK_EVENTS = ['booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.cancelled'];

/**
 * The campaign a booking came from, where the host reads it: the dashboard's
 * page for one booking (`GET /v1/host/bookings/:uid`), the API-key read
 * (`GET /v2/bookings/{uid}`), and every booking webhook. Each answers `utm`,
 * the stored object or null, never a missing key. (MCP get_booking:
 * mcp/mcp.booking-utm.spec.ts.)
 */
describe('the campaign where the host reads a booking', () => {
  let db: Db;
  let accountId: string;
  let introId: string;
  let principal: HostPrincipal;
  let admin: AdminService;
  let host: HostController;
  let crud: AdminCrudController;
  let bookings: BookingService;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    accountId = m.account_id;
    principal = { accountId, memberId: m.id, role: 'owner' };
    const auth = { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService;
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    admin = new AdminService(db, calendar, email);
    host = new HostController(admin, {} as never, auth, {} as never);
    crud = new AdminCrudController(db, auth);
    bookings = new BookingService(db, ENV, calendar, email);
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
  });

  afterEach(async () => {
    await db.close();
  });

  const span = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });

  async function bookIntro(email: string, utm?: unknown, nth = 0) {
    const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[nth]!.startUtc,
      attendee: { name: 'Sam Visitor', email, timeZone: 'UTC' },
      answers: { company: 'Example Co' },
      ...(utm !== undefined ? { utm } : {}),
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    return out;
  }

  describe("the dashboard's page for one booking", () => {
    it('answers the stored campaign, and null on a booking without one', async () => {
      const withCampaign = await bookIntro('utm@example.org', CAMPAIGN);
      const without = await bookIntro('plain@example.org', undefined, 1);

      expect(await host.getBooking(REQ, withCampaign.uid)).toMatchObject({ uid: withCampaign.uid, utm: CAMPAIGN });
      const plain = await host.getBooking(REQ, without.uid);
      expect(plain).toHaveProperty('utm', null);
    });

    it("never reads another account's booking, campaign included", async () => {
      const mine = await bookIntro('mine@example.org', CAMPAIGN);
      const stranger: HostPrincipal = { ...principal, accountId: 'another-account' };
      await expect(admin.getBooking(stranger, mine.uid)).resolves.toBeNull();
    });
  });

  describe('the API-key read, GET /v2/bookings/{uid}', () => {
    const noHost: AuthProvider = { name: 'unused', resolveHost: () => Promise.reject(new Error('unused')) };
    let v2: CalV2Controller;

    beforeEach(() => {
      const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
      const service = new CalV2Service(bookings, db);
      v2 = new CalV2Controller(service, new CalV2PilotService(db, calendar, bookings, service), new AuthService(db, noHost));
    });

    const keyed = async (scopes: string[], eventTypeIds?: string[]): Promise<ReqLike> => ({
      headers: { authorization: `Bearer ${(await createApiKey(db, { accountId, name: 'utm', scopes, eventTypeIds })).plaintext}` },
    });

    it('answers utm with bookings:read, and null on a booking without one', async () => {
      const withCampaign = await bookIntro('v2@example.org', CAMPAIGN);
      const without = await bookIntro('v2-plain@example.org', undefined, 1);
      const req = await keyed(['bookings:read']);

      expect((await v2.getBooking(req, CAL_V2_BOOKINGS_VERSION, withCampaign.uid)).data.utm).toEqual(CAMPAIGN);
      expect((await v2.getBooking(req, CAL_V2_BOOKINGS_VERSION, without.uid)).data.utm).toBeNull();
    });

    it('keeps the scopes: no bookings:read, or a key limited to another event, reads nothing', async () => {
      const b = await bookIntro('scoped@example.org', CAMPAIGN);
      await expect(v2.getBooking(await keyed(['event-types:read']), CAL_V2_BOOKINGS_VERSION, b.uid)).rejects.toThrow();
      const other = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='team-demo'`))!.id;
      const narrow = await keyed(['bookings:read'], [other]);
      await expect(v2.getBooking(narrow, CAL_V2_BOOKINGS_VERSION, b.uid)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('every booking webhook', () => {
    beforeEach(async () => {
      await createWebhook(db, {
        accountId,
        subscriberUrl: 'https://hooks.example.com/bookings',
        eventTriggers: HOOK_EVENTS,
        key: Buffer.alloc(32, 7),
      });
    });

    /** The `data` of the webhook `event` queued for `uid`; the enqueue runs after the answer. */
    async function hookData(uid: string, event: string): Promise<Record<string, unknown>> {
      for (let i = 0; i < 50; i++) {
        const row = await db.get<{ payload: string | null }>(
          sql`SELECT payload FROM outbox WHERE booking_uid = ${uid} AND kind = 'webhook' AND action = ${event} LIMIT 1`,
        );
        if (row?.payload) return (JSON.parse(row.payload) as { data: Record<string, unknown> }).data;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${event} webhook for ${uid}`);
    }

    it('booking.created carries utm: the campaign, or null, never a missing key', async () => {
      const withCampaign = await bookIntro('hook@example.org', CAMPAIGN);
      const without = await bookIntro('hook-plain@example.org', undefined, 1);
      expect(await hookData(withCampaign.uid, 'booking.created')).toMatchObject({ uid: withCampaign.uid, utm: CAMPAIGN });
      expect(await hookData(without.uid, 'booking.created')).toHaveProperty('utm', null);
    });

    it('a team booking.created carries it too', async () => {
      const avail = await bookings.teamAvailability('acme', 'sales', 'team-demo', span().from, span().to);
      const out = await bookings.teamBook('acme', 'sales', {
        slug: 'team-demo',
        startUtc: avail!.slots[0]!.startUtc,
        attendee: { name: 'Sam Visitor', email: 'team-hook@example.org', timeZone: 'UTC' },
        utm: { utm_source: 'linkedin' },
      });
      if ('error' in out) throw new Error(`team book failed: ${out.error}`);
      expect(await hookData(out.uid, 'booking.created')).toMatchObject({ utm: { utm_source: 'linkedin' } });
    });

    it("a host's own booking.created says null: it came from no page", async () => {
      const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
      const out = await admin.hostCreate(
        principal,
        {
          handle: 'alex-rivera',
          slug: 'intro-call',
          startUtc: avail!.slots[2]!.startUtc,
          attendee: { name: 'Pat Host-Made', email: 'pat@example.org', timeZone: 'UTC' },
          answers: { company: 'Example Co' },
        },
        'acme',
      );
      if (!out.ok) throw new Error(`host create failed: ${out.reason}`);
      expect(await hookData(out.booking.uid, 'booking.created')).toHaveProperty('utm', null);
    });

    it('booking.rescheduled and booking.cancelled carry the stored campaign', async () => {
      const made = await bookIntro('move@example.org', CAMPAIGN);
      const avail = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...span() });
      const target = avail!.slots.find((s) => s.startUtc !== made.startUtc)!.startUtc;
      const moved = await bookings.reschedule(made.uid, { newStartUtc: target, byHost: true });
      if ('error' in moved) throw new Error(`reschedule failed: ${moved.error}`);
      expect(await hookData(made.uid, 'booking.rescheduled')).toMatchObject({ uid: made.uid, utm: CAMPAIGN });

      await bookings.cancel(made.uid, { byHost: true, accountId, reason: 'plans changed' });
      expect(await hookData(made.uid, 'booking.cancelled')).toMatchObject({ reason: 'plans changed', utm: CAMPAIGN });

      // The dashboard's own cancel says the same.
      const other = await bookIntro('host-cancel@example.org', { utm_source: 'google' }, 3);
      await admin.hostCancel(principal, other.uid);
      expect(await hookData(other.uid, 'booking.cancelled')).toMatchObject({ utm: { utm_source: 'google' } });
    });

    it('booking.confirmed and a decline carry it, and a booking without one says null', async () => {
      await crud.updateEventType(REQ, introId, { requiresConfirmation: true });
      const request = await bookIntro('confirm@example.org', CAMPAIGN);
      expect(request.status).toBe('pending');
      await admin.confirm(principal, request.uid);
      expect(await hookData(request.uid, 'booking.confirmed')).toMatchObject({ uid: request.uid, utm: CAMPAIGN });

      const declined = await bookIntro('decline@example.org', undefined, 1);
      await admin.decline(principal, declined.uid, 'not a fit');
      expect(await hookData(declined.uid, 'booking.cancelled')).toEqual({ uid: declined.uid, reason: 'not a fit', utm: null });
    });

    it('reads the campaign written after the booking, as a later event would', async () => {
      const made = await bookIntro('late@example.org');
      await setBookingUtm(db, made.uid, { utm_term: 'calendar' });
      await bookings.cancel(made.uid, { byHost: true, accountId });
      expect(await hookData(made.uid, 'booking.cancelled')).toMatchObject({ utm: { utm_term: 'calendar' } });
    });
  });
});
