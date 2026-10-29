import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import { trackingAllowedFor } from './event-tracking-gate';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';

/** The seeded workspace (`acme`) is the one this deployment lets use tracking. */
const ENV = loadServerEnv({ NODE_ENV: 'test', EVENT_TRACKING_ACCOUNTS: 'other, ACME' } as NodeJS.ProcessEnv);
const OFF = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

const ALL = {
  gtmId: 'GTM-ABC1234',
  metaPixelId: '123456789012345',
  posthogKey: 'phc_abcdefghijklmnopqrstuvwxyz0123456789',
  posthogHost: 'https://eu.i.posthog.com',
  hubspotTrackingId: '24681357',
};

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
 * Tracking and pixels per event type, on the API: the editor's save keeps the
 * ids trimmed, drops the blank ones (and a PostHog host with no key), refuses
 * ids with characters no vendor uses and a host that is not https, and the
 * public reads each event page takes them from carry them: the personal and
 * team listings, and the availability read the one-off link page uses.
 */
describe('event type tracking', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let introId: string;
  let teamEventId: string;
  let accountId: string;
  let memberId: string;

  /** The real controller, as an owner (default) or a plain member, on a deployment env. */
  const controller = (role: HostPrincipal['role'] = 'owner', env = ENV) => {
    const principal: HostPrincipal = { accountId, memberId, role };
    const auth = { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService;
    return new AdminCrudController(db, auth, undefined, undefined, undefined, undefined, env);
  };
  const service = (env = ENV) =>
    new BookingService(
      db,
      env,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    accountId = m.account_id;
    memberId = m.id;
    crud = controller();
    bookings = service();
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
    teamEventId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='team-demo'`))!.id;
  });

  describe('the editor save', () => {
    it('stores every id trimmed and reads them back on /v1', async () => {
      const padded = Object.fromEntries(Object.entries(ALL).map(([k, v]) => [k, `  ${v}  `]));
      expect((await crud.updateEventType(REQ, introId, { tracking: padded })).tracking).toEqual(ALL);
      expect((await crud.getEventType(REQ, introId)).tracking).toEqual(ALL);
      const created = await crud.createEventType(REQ, { slug: 'ads', title: 'Ads', lengthMinutes: 30, tracking: { metaPixelId: '42' } });
      expect(created.tracking).toEqual({ metaPixelId: '42' });
    });

    it('leaves blank ids out, a PostHog host without a key out, and stores none when nothing is left', async () => {
      expect((await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1', metaPixelId: '   ', posthogHost: 'https://eu.i.posthog.com' } })).tracking).toEqual({ gtmId: 'GTM-X1' });
      expect((await crud.updateEventType(REQ, introId, { tracking: { gtmId: '', posthogKey: ' ' } })).tracking).toBeNull();
      const raw = await db.get<{ tracking: unknown }>(sql`SELECT tracking FROM event_type WHERE id = ${introId}`);
      expect(raw!.tracking).toBeNull();
    });

    it('keeps them on an edit that omits them, and clears them on null', async () => {
      await crud.updateEventType(REQ, introId, { tracking: ALL });
      expect((await crud.updateEventType(REQ, introId, { title: 'Renamed' })).tracking).toEqual(ALL);
      expect((await crud.updateEventType(REQ, introId, { tracking: null })).tracking).toBeNull();
    });

    it('refuses ids with characters no vendor uses, a host that is not https, and over-long values', async () => {
      for (const bad of [
        { gtmId: 'GTM 123' },
        { metaPixelId: '</script><script>alert(1)</script>' },
        { hubspotTrackingId: '"onload="x' },
        { posthogKey: 'phc_ok', posthogHost: 'http://eu.i.posthog.com' },
        { posthogKey: 'phc_ok', posthogHost: 'javascript:alert(1)' },
        { posthogKey: 'phc_ok', posthogHost: 'https://ph.example.com/ingest?x=1' },
        { posthogKey: 'phc_ok', posthogHost: 'https://user:pass@example.com' },
        { gtmId: `GTM-${'A'.repeat(40)}` },
      ]) {
        const r = await refusalOf(crud.updateEventType(REQ, introId, { tracking: bad }));
        expect(r.error).toBe('BAD_REQUEST');
      }
      expect((await crud.getEventType(REQ, introId)).tracking).toBeNull();
    });

    it('reads as none on every event type that predates it', async () => {
      expect((await crud.getEventType(REQ, introId)).tracking).toBeNull();
      expect((await crud.getEventType(REQ, teamEventId)).tracking).toBeNull();
    });
  });

  describe('the public reads each event page takes them from', () => {
    it('the personal listing carries them, and null for an event without', async () => {
      await crud.updateEventType(REQ, introId, { tracking: ALL });
      await crud.createEventType(REQ, { slug: 'plain', title: 'Plain', lengthMinutes: 30 });
      const profile = await bookings.profile('acme', 'alex-rivera');
      expect(profile!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual(ALL);
      expect(profile!.eventTypes.find((e) => e.slug === 'plain')!.tracking).toBeNull();
    });

    it('the team listing carries them', async () => {
      await crud.updateEventType(REQ, teamEventId, { tracking: { gtmId: 'GTM-TEAM1' } });
      const team = await bookings.teamProfile('acme', 'sales');
      expect(team!.eventTypes.find((e) => e.slug === 'team-demo')!.tracking).toEqual({ gtmId: 'GTM-TEAM1' });
    });

    it('the availability reads carry them too (the one-off link page reads its event from there)', async () => {
      await crud.updateEventType(REQ, introId, { tracking: { metaPixelId: '987654321' } });
      await crud.updateEventType(REQ, teamEventId, { tracking: { hubspotTrackingId: '1357' } });
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 7 * DAY).toISOString();
      const personal = await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to });
      expect(personal!.eventType.tracking).toEqual({ metaPixelId: '987654321' });
      const team = await bookings.teamAvailability('acme', 'sales', 'team-demo', from, to);
      expect(team!.eventType.tracking).toEqual({ hubspotTrackingId: '1357' });
    });
  });

  describe('the deployment gate (EVENT_TRACKING_ACCOUNTS) and who may set it', () => {
    it('matches short codes and vanity slugs case-insensitively, `*` is everyone, unset is nobody', () => {
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'acme' }, { code: 'ACME' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'x, my-brand ' }, { code: 'k3j2', vanitySlug: 'My-Brand' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: '*' }, { code: 'anyone' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'acme' }, { code: 'acmex' })).toBe(false);
      expect(trackingAllowedFor({}, { code: 'acme' })).toBe(false);
      expect(trackingAllowedFor(undefined, { code: 'acme' })).toBe(false);
    });

    it('refuses to store tracking for a workspace the deployment does not name, and still lets it clear', async () => {
      const off = controller('owner', OFF);
      const r = await refusalOf(off.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1' } }));
      expect(r.error).toBe('TRACKING_DISABLED');
      await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1' } });
      expect((await off.updateEventType(REQ, introId, { tracking: null })).tracking).toBeNull();
    });

    it('a plain member cannot set or change tracking, but can still save their event as it is', async () => {
      await crud.updateEventType(REQ, introId, { tracking: { metaPixelId: '42' } });
      const member = controller('member');
      await expect(member.updateEventType(REQ, introId, { tracking: { metaPixelId: '43' } })).rejects.toMatchObject({ status: 403 });
      await expect(member.updateEventType(REQ, introId, { tracking: null })).rejects.toMatchObject({ status: 403 });
      // The editor sends the stored ids back unchanged: that is not a change.
      expect((await member.updateEventType(REQ, introId, { title: 'Renamed', tracking: { metaPixelId: '42' } })).title).toBe('Renamed');
      await expect(member.createEventType(REQ, { slug: 'm', title: 'M', lengthMinutes: 30, tracking: { gtmId: 'GTM-M1' } })).rejects.toMatchObject({ status: 403 });
    });

    it('takes the tags off every public read the moment a workspace is not allowed, whatever is stored', async () => {
      await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1' } });
      await crud.updateEventType(REQ, teamEventId, { tracking: { gtmId: 'GTM-T1' } });
      const off = service(OFF);
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 7 * DAY).toISOString();
      expect((await off.profile('acme', 'alex-rivera'))!.eventTypes.every((e) => e.tracking === null)).toBe(true);
      expect((await off.teamProfile('acme', 'sales'))!.eventTypes.every((e) => e.tracking === null)).toBe(true);
      expect((await off.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to }))!.eventType.tracking).toBeUndefined();
      expect((await off.teamAvailability('acme', 'sales', 'team-demo', from, to))!.eventType.tracking).toBeUndefined();
      // And on again, read straight back.
      expect((await bookings.profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual({ gtmId: 'GTM-X1' });
    });

    it('drops, on read, a value written past the API that the save would refuse', async () => {
      await db.run(sql`UPDATE event_type SET tracking = ${JSON.stringify({ gtmId: '"><script>', metaPixelId: '42' })} WHERE id = ${introId}`);
      expect((await crud.getEventType(REQ, introId)).tracking).toEqual({ metaPixelId: '42' });
      expect((await bookings.profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual({ metaPixelId: '42' });
    });
  });
});
