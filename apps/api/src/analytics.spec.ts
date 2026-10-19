import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, getAvailability, listOutbox, migrate, seed, sql, type Db, type OutboxRow } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { ANALYTICS_GROUP_TYPE, POSTHOG_DEFAULT_HOST } from '@slate/shared';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AnalyticsEffects } from './analytics-effects';
import {
  AnalyticsRejectedError,
  PosthogAnalyticsProvider,
  createAnalyticsProvider,
  type AnalyticsProvider,
} from './analytics.provider';
import { AdminCrudController } from './admin-crud.controller';
import { AdminService } from './admin.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { GrowthService } from './growth.service';
import { HostController } from './host.controller';
import { OnboardingService } from './onboarding.service';
import { OutboxWorker } from './outbox.worker';
import { LocalAuthProvider, type SignupNotice } from './auth.provider';
import { WorkOsAuthProvider } from './auth.provider.workos';
import { signJwtHs256 } from './jwt';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

/**
 * Product analytics, the API half: what is ENQUEUED (and that nothing is when
 * analytics is off), what the PostHog adapter SENDS, and what never leaves:
 * a visitor's email or name.
 */

const KEY = 'phc_test_key';
const HOST = 'https://ingest.example.test';

function env(over: Partial<Record<string, string>> = {}): ServerEnv {
  return loadServerEnv({
    NODE_ENV: 'test',
    PUBLIC_APP_URL: 'https://calendar.example.test',
    ...over,
  } as NodeJS.ProcessEnv);
}

const ON = {
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: KEY,
  PRODUCT_ANALYTICS_HOST: HOST,
  PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'jordan@',
};

/** A provider that records what it was asked to deliver. */
function recordingProvider(): AnalyticsProvider & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    name: 'recording',
    sent,
    capture: async (e) => void sent.push({ kind: 'capture', ...e }),
    updateAccount: async (u) => void sent.push({ kind: 'account', ...u }),
  };
}

type Payload = {
  type: 'capture' | 'account';
  capture?: { event: string; distinctId: string; accountKey: string | null; properties: Record<string, unknown>; personSet?: Record<string, unknown> };
  update?: { accountKey: string; properties: Record<string, unknown> };
};

describe('product analytics (API)', () => {
  let db: Db;
  let accountId: string;
  let alex: string;
  let jordan: string;
  let principal: HostPrincipal;

  const rows = async (): Promise<OutboxRow[]> => (await listOutbox(db, { kind: 'analytics' })) as OutboxRow[];
  const payloads = async (): Promise<Payload[]> => (await rows()).map((r) => JSON.parse(r.payload!) as Payload);
  const captures = async () => (await payloads()).filter((p) => p.type === 'capture').map((p) => p.capture!);

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    principal = { accountId, memberId: alex, role: 'owner' };
  });

  // --- Off: the fork default --------------------------------------------

  describe('off', () => {
    it('selects no provider unless a known provider AND a key are set', () => {
      expect(createAnalyticsProvider(env(), ANALYTICS_GROUP_TYPE)).toBeNull();
      expect(createAnalyticsProvider(env({ PRODUCT_ANALYTICS_PROVIDER: 'posthog' }), ANALYTICS_GROUP_TYPE)).toBeNull();
      expect(createAnalyticsProvider(env({ PRODUCT_ANALYTICS_KEY: KEY }), ANALYTICS_GROUP_TYPE)).toBeNull();
      expect(
        createAnalyticsProvider(env({ PRODUCT_ANALYTICS_PROVIDER: 'acme', PRODUCT_ANALYTICS_KEY: KEY }), ANALYTICS_GROUP_TYPE),
      ).toBeNull();
      expect(createAnalyticsProvider(env(ON), ANALYTICS_GROUP_TYPE)?.name).toBe('posthog');
    });

    it('a mistyped provider never stops the API booting', () => {
      expect(() => env({ PRODUCT_ANALYTICS_PROVIDER: 'PostHug', PRODUCT_ANALYTICS_HOST: 'not a url' })).not.toThrow();
    });

    it('enqueues nothing, reads nothing and sends nothing', async () => {
      const fx = new AnalyticsEffects(db, null, env());
      const spy = vi.spyOn(db, 'get');
      expect(fx.enabled).toBe(false);
      await fx.hostEvent('hours_set', principal, { rule_count: 5 });
      await fx.signup({ accountId, memberId: alex, role: 'owner', isFirstMember: true, fromInvite: false });
      await fx.attributionCaptured(principal, { utm_source: 'google' });
      await fx.bookingCreated({ uid: 'x', inviteeEmail: 'a@b.c', channel: 'booking_page', isTeam: false });
      expect(spy).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    });

    it('a row left behind after analytics was turned off drains as skipped, once', async () => {
      const on = new AnalyticsEffects(db, recordingProvider(), env(ON));
      await on.hostEvent('hours_set', principal);
      const worker = workerWith(db, new AnalyticsEffects(db, null, env()));
      await worker.drainOnce();
      const [row] = await rows();
      expect(row!.status).toBe('skipped');
      expect(row!.lastError).toMatch(/not configured/);
    });
  });

  // --- On: what is enqueued --------------------------------------------

  describe('on', () => {
    let fx: AnalyticsEffects;
    beforeEach(() => {
      fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
    });

    it('a host event is about the host, filed under the account short code', async () => {
      await fx.hostEvent('hours_set', principal, { rule_count: 5, created: true });
      const [row] = await rows();
      expect(row!.action).toBe('calendars_hours_set');
      expect(row!.accountId).toBe(accountId);
      const [c] = await captures();
      expect(c).toMatchObject({
        event: 'calendars_hours_set',
        distinctId: 'alex@example.com',
        accountKey: 'acme',
        properties: {
          rule_count: 5,
          created: true,
          product: 'calendars',
          is_internal: false,
          account_code: 'acme',
          $host: 'calendar.example.test',
        },
      });
    });

    it('marks the operator’s own people from the configured patterns', async () => {
      await fx.hostEvent('hours_set', { accountId, memberId: jordan });
      const [c] = await captures();
      expect(c!.properties['is_internal']).toBe(true);
    });

    it('drops a member with no email rather than invent an id', async () => {
      await db.run(sql`UPDATE member SET email = NULL WHERE id = ${alex}`);
      await fx.hostEvent('hours_set', principal);
      expect(await rows()).toEqual([]);
    });

    it('clamps a long string property', async () => {
      await fx.hostEvent('branding_changed', principal, { fields: 'x'.repeat(5000) });
      const [c] = await captures();
      expect(String(c!.properties['fields'])).toHaveLength(200);
    });

    it('never rejects into the caller', async () => {
      vi.spyOn(db, 'get').mockRejectedValueOnce(new Error('db down'));
      await expect(fx.hostEvent('hours_set', principal)).resolves.toBeUndefined();
    });

    it('a first member is a signup and describes the new account; an invite only joins it', async () => {
      await fx.signup({ accountId, memberId: alex, role: 'owner', isFirstMember: true, fromInvite: false });
      await fx.signup({ accountId, memberId: jordan, role: 'member', isFirstMember: false, fromInvite: true });
      const all = await payloads();
      expect(all.map((p) => p.type)).toEqual(['capture', 'account', 'capture']);
      expect(all[0]!.capture).toMatchObject({
        event: 'calendars_signup_completed',
        distinctId: 'alex@example.com',
        properties: { role: 'owner', is_first_member: true, from_invite: false },
        personSet: { email: 'alex@example.com', is_internal: false },
      });
      expect(all[1]!.update).toMatchObject({ accountKey: 'acme', properties: { is_internal: false, account_code: 'acme' } });
      expect(all[2]!.capture!.properties).toMatchObject({ from_invite: true, is_internal: true });
    });

    it('the signup source: campaign tags, the referrer as a domain, click ids as a flag', async () => {
      await fx.attributionCaptured(principal, {
        utm_source: 'chatgpt.com',
        utm_medium: 'referral',
        gclid: 'Cj0KCQ-secret-click-id',
        referer: 'https://chatgpt.com/c/abc?q=alex@example.com',
      });
      const [event, account] = await payloads();
      expect(event!.capture!.properties).toMatchObject({
        utm_source: 'chatgpt.com',
        utm_medium: 'referral',
        referrer_domain: 'chatgpt.com',
        has_click_id: true,
      });
      expect(account!.update!.properties).toMatchObject({ utm_source: 'chatgpt.com', referrer_domain: 'chatgpt.com' });
      const sent = JSON.stringify(await payloads());
      expect(sent).not.toContain('secret-click-id');
      expect(sent).not.toContain('/c/abc');
    });
  });

  // --- Bookings: about the host, never the visitor ----------------------

  describe('booking_created', () => {
    const calendarFx = (d: Db) => new CalendarEffects(new DisabledCalendarProvider(), d);
    const emailFx = (d: Db) => new EmailEffects(new BookingNotifier(new NoopEmailProvider()), d);

    const firstSlot = () => getAvailabilityFor(db);

    it('records the host, the channel and two booleans; the visitor email never leaves', async () => {
      const fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      const svc = new BookingService(db, env(), calendarFx(db), emailFx(db), undefined, undefined, undefined, undefined, fx);
      const out = await svc.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: await firstSlot(),
        attendee: { name: 'Vera Visitor', email: 'vera.visitor@example.org', timeZone: 'UTC' },
        answers: { company: 'Vera Co' },
      });
      expect('error' in out).toBe(false);
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      const [c] = await captures();
      expect(c).toMatchObject({
        event: 'calendars_booking_created',
        distinctId: 'alex@example.com',
        accountKey: 'acme',
        properties: { channel: 'booking_page', is_team: false, invitee_is_member: false, invitee_is_internal: false },
      });
      const sent = JSON.stringify(await payloads());
      expect(sent).not.toContain('vera.visitor');
      expect(sent).not.toContain('Vera');
    });

    it('a member booking their own page is told apart', async () => {
      const fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      const svc = new BookingService(db, env(), calendarFx(db), emailFx(db), undefined, undefined, undefined, undefined, fx);
      await svc.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: await firstSlot(),
        attendee: { name: 'Jordan', email: 'JORDAN@example.com', timeZone: 'UTC' },
        answers: { company: 'Acme' },
      });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      const [c] = await captures();
      expect(c!.properties).toMatchObject({ invitee_is_member: true, invitee_is_internal: true });
    });
  });

  // --- Delivery: the PostHog adapter and the worker ---------------------

  describe('delivery', () => {
    function posthog(status = 200) {
      const provider = new PosthogAnalyticsProvider(
        { provider: 'posthog', key: KEY, host: HOST },
        ANALYTICS_GROUP_TYPE,
      );
      const fetchImpl = vi.fn(async () => new Response('{}', { status }));
      provider.fetchImpl = fetchImpl as unknown as typeof fetch;
      return { provider, fetchImpl };
    }
    const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, i = 0) =>
      JSON.parse((fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as {
        [key: string]: unknown;
        uuid: string;
        timestamp: string;
      };

    it('posts one event to the capture endpoint, with the group and the person set', async () => {
      const { provider, fetchImpl } = posthog();
      const fx = new AnalyticsEffects(db, provider, env(ON));
      await fx.signup({ accountId, memberId: alex, role: 'owner', isFirstMember: true, fromInvite: false });
      await workerWith(db, fx).drainOnce();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${HOST}/capture/`);
      const event = bodyOf(fetchImpl, 0);
      expect(event).toMatchObject({
        api_key: KEY,
        event: 'calendars_signup_completed',
        distinct_id: 'alex@example.com',
        properties: {
          $groups: { calendars_account: 'acme' },
          $set: { email: 'alex@example.com', is_internal: false },
        },
      });
      expect(event['uuid']).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(event['timestamp']).toISOString()).toBe(event['timestamp']);
      const account = bodyOf(fetchImpl, 1);
      expect(account).toMatchObject({
        event: '$groupidentify',
        properties: { $group_type: 'calendars_account', $group_key: 'acme', $group_set: { is_internal: false } },
      });
      expect((await rows()).every((r) => r.status === 'done')).toBe(true);
    });

    it('a refused event is skipped once; a vendor hiccup is retried', async () => {
      for (const [status, expected] of [
        [400, 'skipped'],
        [401, 'skipped'],
        [429, 'pending'],
        [503, 'pending'],
      ] as const) {
        await db.run(sql`DELETE FROM outbox`);
        const { provider } = posthog(status);
        const fx = new AnalyticsEffects(db, provider, env(ON));
        await fx.hostEvent('hours_set', principal);
        await workerWith(db, fx).drainOnce();
        const [row] = await rows();
        expect([status, row!.status]).toEqual([status, expected]);
      }
    });

    it('a network failure is retried, and the rejection type is the only permanent one', async () => {
      const { provider } = posthog();
      provider.fetchImpl = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await expect(
        provider.capture({ uuid: 'u', event: 'e', distinctId: 'd', timestamp: 0, properties: {}, accountKey: null }),
      ).rejects.not.toBeInstanceOf(AnalyticsRejectedError);
    });

    it('uses the vendor host when none is configured', () => {
      const provider = createAnalyticsProvider(
        env({ PRODUCT_ANALYTICS_PROVIDER: 'posthog', PRODUCT_ANALYTICS_KEY: KEY }),
        ANALYTICS_GROUP_TYPE,
      ) as PosthogAnalyticsProvider;
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
      provider.fetchImpl = fetchImpl as unknown as typeof fetch;
      void provider.capture({ uuid: 'u', event: 'e', distinctId: 'd', timestamp: 0, properties: {}, accountKey: null });
      expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${POSTHOG_DEFAULT_HOST}/capture/`);
    });
  });

  // --- Call sites --------------------------------------------------------

  describe('call sites', () => {
    let fx: AnalyticsEffects;
    let growth: GrowthService;
    const REQ = {} as ReqLike;
    const auth = () => ({ resolveHost: async () => principal }) as unknown as AuthService;
    const events = async () => (await captures()).map((c) => [c.event, c.properties] as const);

    beforeEach(() => {
      fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      growth = new GrowthService(db);
    });

    const admin = () =>
      new AdminService(
        db,
        new CalendarEffects(new DisabledCalendarProvider(), db),
        new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
      );
    const host = () =>
      new HostController(admin(), new OnboardingService(db, undefined, growth), auth(), growth, undefined, fx);
    const crud = () => new AdminCrudController(db, auth(), growth, undefined, fx);

    it('choosing a template is the template and the first publish', async () => {
      await host().submitSetup(REQ, { templateId: '30min' });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
      const names = (await events()).map(([e]) => e);
      expect(names).toEqual(['calendars_template_chosen', 'calendars_event_type_published']);
      expect((await events())[0]![1]).toMatchObject({ template: '30min' });
    });

    it('a claimed signup source is recorded; a refused claim is not', async () => {
      await db.run(sql`UPDATE account SET created_at = ${Date.now() - 1000}, attribution = NULL WHERE id = ${accountId}`);
      await host().claimAttribution(REQ, { attribution: { utm_source: 'google' } });
      await host().claimAttribution(REQ, { attribution: { utm_source: 'bing' } });
      await vi.waitFor(async () => expect((await events()).length).toBeGreaterThan(0));
      const recorded = (await events()).filter(([e]) => e === 'calendars_attribution_captured');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]![1]).toMatchObject({ utm_source: 'google' });
    });

    it('only a visible event type is a publish, and only the save that makes it visible', async () => {
      const base = { title: 'Demo', lengthMinutes: 30 };
      const hidden = await crud().createEventType(REQ, { ...base, slug: 'demo-hidden', hidden: true });
      await crud().createEventType(REQ, { ...base, slug: 'demo-visible' });
      await crud().updateEventType(REQ, (hidden as { id: string }).id, { title: 'Demo, renamed' });
      await crud().updateEventType(REQ, (hidden as { id: string }).id, { hidden: false });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
      expect((await events()).map(([e, p]) => [e, p['source']])).toEqual([
        ['calendars_event_type_published', 'dashboard'],
        ['calendars_event_type_published', 'dashboard'],
      ]);
    });

    it('hours are set by a save that carries rules, not by a rename', async () => {
      const created = (await crud().createSchedule(REQ, {
        name: 'Weekdays',
        timeZone: 'UTC',
        rules: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null }],
      })) as { id: string };
      await crud().updateSchedule(REQ, created.id, { name: 'Renamed' });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      expect((await events())[0]).toEqual(['calendars_hours_set', expect.objectContaining({ rule_count: 1, created: true })]);
    });

    it('turning the branding off is recorded with its new state', async () => {
      await host().setBranding(REQ, { hideBranding: true });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      expect((await events())[0]).toEqual(['calendars_hide_branding_toggled', expect.objectContaining({ hidden: true })]);
    });

    it('a studio save names the settings that moved, never their values', async () => {
      await host().updateBranding(REQ, { brandColor: '#123456' });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      const [event, props] = (await events())[0]!;
      expect(event).toBe('calendars_branding_changed');
      expect(props).toMatchObject({ change: 'page_style', fields: 'brandColor' });
      expect(JSON.stringify(props)).not.toContain('#123456');
    });
  });

  // --- Signups, as the auth providers report them ------------------------

  describe('signup observer', () => {
    const SECRET = 'analytics-signup-test-secret';
    const mint = (claims: Record<string, unknown>) =>
      signJwtHs256({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, SECRET);
    const bearer = (t: string): ReqLike => ({ headers: { authorization: `Bearer ${t}` } });

    it('the WorkOS provider reports a JIT member once, an existing one never', async () => {
      const seen: SignupNotice[] = [];
      const provider = new WorkOsAuthProvider(db, { JWT_SECRET: SECRET }, (s) => void seen.push(s));
      const token = mint({ account_id: 'ext_a', sub: 'ext_u', email: 'new@x.io', name: 'New' });
      await provider.resolveHost(bearer(token));
      await provider.resolveHost(bearer(token));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ role: 'owner', isFirstMember: true, fromInvite: false });

      await provider.resolveHost(bearer(mint({ account_id: 'ext_a', sub: 'ext_u2', email: 'second@x.io' })));
      expect(seen[1]).toMatchObject({ role: 'member', isFirstMember: false, fromInvite: false });
    });

    it('the WorkOS provider reports an adopted invite', async () => {
      const seen: SignupNotice[] = [];
      const provider = new WorkOsAuthProvider(db, { JWT_SECRET: SECRET }, (s) => void seen.push(s));
      await provider.resolveHost(bearer(mint({ account_id: 'ext_b', sub: 'owner', email: 'owner@x.io' })));
      const acct = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE external_id = 'ext_b'`))!.id;
      await db.run(
        sql`INSERT INTO member (id, account_id, email, role, status, created_at)
            VALUES ('invited-1', ${acct}, 'guest@x.io', 'admin', 'invited', ${Date.now()})`,
      );
      await provider.resolveHost(bearer(mint({ account_id: 'ext_b', sub: 'guest', email: 'guest@x.io' })));
      expect(seen[1]).toMatchObject({ memberId: 'invited-1', role: 'admin', fromInvite: true, isFirstMember: false });
    });

    it('a throwing observer never costs the login', async () => {
      const provider = new WorkOsAuthProvider(db, { JWT_SECRET: SECRET }, () => {
        throw new Error('telemetry down');
      });
      await expect(
        provider.resolveHost(bearer(mint({ account_id: 'ext_c', sub: 'u', email: 'c@x.io' }))),
      ).resolves.toMatchObject({ memberId: expect.any(String) });
    });

    it('the local dev provider reports its JIT member', async () => {
      const seen: SignupNotice[] = [];
      const provider = new LocalAuthProvider(db, { NODE_ENV: 'test' }, (s) => void seen.push(s));
      await provider.resolveHost({ headers: { 'x-slate-email': 'dev-new@x.io' } });
      await provider.resolveHost({ headers: { 'x-slate-email': 'dev-new@x.io' } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ role: 'owner', isFirstMember: true });
    });
  });
});

/** A worker that only ever sees `analytics` rows in these tests. */
function workerWith(db: Db, analytics: AnalyticsEffects): OutboxWorker {
  return new OutboxWorker(
    db,
    loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    new CalendarEffects(new DisabledCalendarProvider(), db),
    new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    new DaptaSyncEffects(),
    undefined,
    analytics,
  );
}

async function getAvailabilityFor(db: Db): Promise<string> {
  const a = await getAvailability(db, {
    accountCode: 'acme',
    handle: 'alex-rivera',
    slug: 'intro-call',
    fromMs: Date.now(),
    toMs: Date.now() + 10 * 86_400_000,
  });
  return a!.slots[0]!.startUtc;
}
