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

/** The seeded workspace (`acme`) is the one this deployment lets use GTM, GA4 and HubSpot. */
const ENV = loadServerEnv({ NODE_ENV: 'test', EVENT_TRACKING_ACCOUNTS: 'other, ACME' } as NodeJS.ProcessEnv);
const OFF = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

/** The ids that load only vendor code: every workspace may set them. */
const OPEN = {
  metaPixelId: '123456789012345',
  posthogKey: 'phc_abcdefghijklmnopqrstuvwxyz0123456789',
  posthogHost: 'https://eu.i.posthog.com',
};
/** The ids that can run the host's own code: only where the deployment allows them. */
const SCRIPTS = { gtmId: 'GTM-ABC1234', ga4Id: 'G-ABC123XYZ9', hubspotTrackingId: '24681357' };
const ALL = { ...OPEN, ...SCRIPTS };

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
 * Tracking and pixels per event type, on the API: the editor's save keeps each
 * id in its vendor's own format (trimmed, GTM and GA4 upper-cased), drops the
 * blank ones (and a PostHog host with no key), refuses anything else, including
 * a PostHog host that is not PostHog's own cloud, and the public reads each
 * event page takes them from carry them: the personal and team listings, and
 * the availability read the one-off link page uses. Meta and PostHog are open
 * to every workspace; GTM, GA4 and HubSpot only to the ones the deployment
 * names.
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
    it('stores every id in its vendor format and reads them back on /v1', async () => {
      const padded = Object.fromEntries(Object.entries(ALL).map(([k, v]) => [k, `  ${v}  `]));
      expect((await crud.updateEventType(REQ, introId, { tracking: padded })).tracking).toEqual(ALL);
      expect((await crud.getEventType(REQ, introId)).tracking).toEqual(ALL);
      const created = await crud.createEventType(REQ, { slug: 'ads', title: 'Ads', lengthMinutes: 30, tracking: { metaPixelId: '424242424242' } });
      expect(created.tracking).toEqual({ metaPixelId: '424242424242' });
    });

    it('upper-cases GTM and GA4 ids, and keeps a PostHog host as its bare origin', async () => {
      const saved = await crud.updateEventType(REQ, introId, {
        tracking: { gtmId: 'gtm-abc1234', ga4Id: 'g-abc123xyz9', posthogKey: OPEN.posthogKey, posthogHost: 'HTTPS://US.i.posthog.com/' },
      });
      expect(saved.tracking).toEqual({ gtmId: 'GTM-ABC1234', ga4Id: 'G-ABC123XYZ9', posthogKey: OPEN.posthogKey, posthogHost: 'https://us.i.posthog.com' });
    });

    it('leaves blank ids out, a PostHog host without a key out, and stores none when nothing is left', async () => {
      expect((await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1Y2Z3', metaPixelId: '   ', posthogHost: 'https://eu.i.posthog.com' } })).tracking).toEqual({ gtmId: 'GTM-X1Y2Z3' });
      expect((await crud.updateEventType(REQ, introId, { tracking: { gtmId: '', posthogKey: ' ' } })).tracking).toBeNull();
      const raw = await db.get<{ tracking: unknown }>(sql`SELECT tracking FROM event_type WHERE id = ${introId}`);
      expect(raw!.tracking).toBeNull();
    });

    it('keeps them on an edit that omits them, and clears them on null', async () => {
      await crud.updateEventType(REQ, introId, { tracking: ALL });
      expect((await crud.updateEventType(REQ, introId, { title: 'Renamed' })).tracking).toEqual(ALL);
      expect((await crud.updateEventType(REQ, introId, { tracking: null })).tracking).toBeNull();
    });

    it('refuses an id not shaped like its vendor’s, any PostHog host but PostHog’s own cloud, and over-long values', async () => {
      for (const bad of [
        { gtmId: 'GTM 123' },
        { gtmId: 'ABC1234' },
        { ga4Id: 'UA-12345-1' },
        { ga4Id: 'G-ABC 123' },
        { metaPixelId: '</script><script>alert(1)</script>' },
        { metaPixelId: '12345abc' },
        { hubspotTrackingId: '"onload="x' },
        { hubspotTrackingId: 'abc123' },
        { posthogKey: 'project_key_without_the_phc_prefix' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'http://eu.i.posthog.com' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'javascript:alert(1)' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'https://ph.example.com' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'https://eu.i.posthog.com.example.com' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'https://eu.i.posthog.com/ingest' },
        { posthogKey: OPEN.posthogKey, posthogHost: 'https://user:pass@example.com' },
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

  describe('who may set what: every workspace the vendor-only ids, the deployment GTM, GA4 and HubSpot', () => {
    it('matches short codes and vanity slugs case-insensitively, `*` is everyone, unset is nobody', () => {
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'acme' }, { code: 'ACME' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'x, my-brand ' }, { code: 'k3j2', vanitySlug: 'My-Brand' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: '*' }, { code: 'anyone' })).toBe(true);
      expect(trackingAllowedFor({ EVENT_TRACKING_ACCOUNTS: 'acme' }, { code: 'acmex' })).toBe(false);
      expect(trackingAllowedFor({}, { code: 'acme' })).toBe(false);
      expect(trackingAllowedFor(undefined, { code: 'acme' })).toBe(false);
    });

    it('any workspace stores Meta and PostHog with no permission from the deployment', async () => {
      const off = controller('owner', OFF);
      expect((await off.updateEventType(REQ, introId, { tracking: OPEN })).tracking).toEqual(OPEN);
      const created = await off.createEventType(REQ, { slug: 'ads', title: 'Ads', lengthMinutes: 30, tracking: { metaPixelId: '424242424242' } });
      expect(created.tracking).toEqual({ metaPixelId: '424242424242' });
    });

    it('refuses a new or changed GTM container, GA4 property or HubSpot portal where the deployment does not name the workspace', async () => {
      const off = controller('owner', OFF);
      for (const scripts of [{ gtmId: 'GTM-X1Y2Z3' }, { ga4Id: 'G-ABC123XYZ9' }, { hubspotTrackingId: '1357' }, { ...OPEN, gtmId: 'GTM-X1Y2Z3' }]) {
        const r = await refusalOf(off.updateEventType(REQ, introId, { tracking: scripts }));
        expect(r.error).toBe('TRACKING_DISABLED');
      }
      await expect(
        off.createEventType(REQ, { slug: 'g', title: 'G', lengthMinutes: 30, tracking: { gtmId: 'GTM-X1Y2Z3' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Stored while allowed, then changed while not: refused too.
      await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1Y2Z3' } });
      expect((await refusalOf(off.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-Z9Y8X7' } }))).error).toBe('TRACKING_DISABLED');
    });

    it('still lets that workspace clear them, or edit the other ids around a stored one', async () => {
      await crud.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1Y2Z3' } });
      const off = controller('owner', OFF);
      // The editor sends the stored container back unchanged next to a new pixel.
      expect((await off.updateEventType(REQ, introId, { tracking: { gtmId: 'GTM-X1Y2Z3', metaPixelId: '424242424242' } })).tracking).toEqual({
        gtmId: 'GTM-X1Y2Z3',
        metaPixelId: '424242424242',
      });
      expect((await off.updateEventType(REQ, introId, { tracking: { metaPixelId: '424242424242' } })).tracking).toEqual({ metaPixelId: '424242424242' });
      expect((await off.updateEventType(REQ, introId, { tracking: null })).tracking).toBeNull();
    });

    it('a plain member cannot set or change any id, but can still save their event as it is', async () => {
      await crud.updateEventType(REQ, introId, { tracking: { metaPixelId: '424242424242' } });
      const member = controller('member');
      await expect(member.updateEventType(REQ, introId, { tracking: { metaPixelId: '434343434343' } })).rejects.toMatchObject({ status: 403 });
      await expect(member.updateEventType(REQ, introId, { tracking: null })).rejects.toMatchObject({ status: 403 });
      // The editor sends the stored ids back unchanged: that is not a change.
      expect((await member.updateEventType(REQ, introId, { title: 'Renamed', tracking: { metaPixelId: '424242424242' } })).title).toBe('Renamed');
      await expect(member.createEventType(REQ, { slug: 'm', title: 'M', lengthMinutes: 30, tracking: { metaPixelId: '424242424242' } })).rejects.toMatchObject({ status: 403 });
    });

    it('takes GTM, GA4 and HubSpot off every public read the moment a workspace is not allowed, and leaves the rest', async () => {
      await crud.updateEventType(REQ, introId, { tracking: ALL });
      await crud.updateEventType(REQ, teamEventId, { tracking: { gtmId: 'GTM-TEAM1' } });
      const off = service(OFF);
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 7 * DAY).toISOString();
      expect((await off.profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual(OPEN);
      expect((await off.teamProfile('acme', 'sales'))!.eventTypes.find((e) => e.slug === 'team-demo')!.tracking).toBeNull();
      expect((await off.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to }))!.eventType.tracking).toEqual(OPEN);
      expect((await off.teamAvailability('acme', 'sales', 'team-demo', from, to))!.eventType.tracking).toBeUndefined();
      // And on again, read straight back.
      expect((await bookings.profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual(ALL);
    });

    it('drops, on read, a value written past the API (or under the older, looser rules) that the save would refuse', async () => {
      await db.run(
        sql`UPDATE event_type SET tracking = ${JSON.stringify({ gtmId: '"><script>', metaPixelId: '424242424242', posthogKey: OPEN.posthogKey, posthogHost: 'https://ph.tenant.example' })} WHERE id = ${introId}`,
      );
      // The PostHog key goes with its refused host: its events would otherwise
      // land on a cloud the host never chose.
      const expected = { metaPixelId: '424242424242' };
      expect((await crud.getEventType(REQ, introId)).tracking).toEqual(expected);
      expect((await bookings.profile('acme', 'alex-rivera'))!.eventTypes.find((e) => e.slug === 'intro-call')!.tracking).toEqual(expected);
    });
  });
});
