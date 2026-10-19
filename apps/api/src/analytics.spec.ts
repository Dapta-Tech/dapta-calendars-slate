import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, createEventType, createTeam, getAvailability, listOutbox, migrate, seed, sql, type Db, type OutboxRow } from '@slate/db';
import { DisabledCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { ANALYTICS_GROUP_TYPE, POSTHOG_DEFAULT_HOST } from '@slate/shared';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AnalyticsEffects, analyticsLabel } from './analytics-effects';
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
  /**
   * Events are fire-and-forget, so a count read the moment the first row lands
   * would miss a wrong second one. Wait until the outbox has stopped growing
   * (unchanged across several reads), then read.
   */
  const settled = async () => {
    let last = -1;
    let steady = 0;
    for (let i = 0; i < 100 && steady < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const n = (await rows()).length;
      steady = n === last ? steady + 1 : 0;
      last = n;
    }
    return captures();
  };

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

    it('keeps flat primitives only, and reduces untrusted labels to an identifier or other', async () => {
      await fx.hostEvent('hours_set', principal, { nested: { a: 1 } as never, ok: 1 });
      const [c] = await captures();
      expect(c!.properties).not.toHaveProperty('nested');
      expect(c!.properties['ok']).toBe(1);
      expect(analyticsLabel('Google')).toBe('google');
      expect(analyticsLabel('microsoft-outlook-calendar')).toBe('microsoft-outlook-calendar');
      expect(analyticsLabel('two words')).toBe('other');
      expect(analyticsLabel({ evil: true })).toBe('other');
      expect(analyticsLabel('x'.repeat(41))).toBe('other');
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

    it('a campaign tag that is an address, a URL or a query never reaches either payload', async () => {
      await fx.attributionCaptured(principal, {
        utm_source: 'newsletter',
        utm_content: 'ana@example.com',
        utm_term: 'https://evil.test/x?email=bob@example.com',
        utm_campaign: 'a=1&b=2',
      });
      const [event, account] = await payloads();
      expect(event!.capture!.properties).toMatchObject({ utm_source: 'newsletter', utm_withheld: true });
      expect(event!.capture!.properties).not.toHaveProperty('utm_content');
      expect(account!.update!.properties).toEqual({ utm_source: 'newsletter', account_code: 'acme' });
      const sent = JSON.stringify(await payloads());
      expect(sent).not.toContain('ana@example.com');
      expect(sent).not.toContain('bob@example.com');
      expect(sent).not.toContain('evil.test');
      expect(sent).not.toContain('a=1');
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

  describe('booking_created, the paths that must not count twice', () => {
    const service = (fx: AnalyticsEffects) =>
      new BookingService(
        db,
        env(),
        new CalendarEffects(new DisabledCalendarProvider(), db),
        new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
        undefined,
        undefined,
        undefined,
        undefined,
        fx,
      );

    it('a replayed API booking (same idempotency key) records nothing the second time', async () => {
      const fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      const svc = service(fx);
      const body = {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: await getAvailabilityFor(db),
        attendee: { name: 'Rae', email: 'rae@example.org', timeZone: 'UTC' },
        answers: { company: 'Rae Co' },
      };
      const context = { apiKeyWrite: true, idempotencyKey: 'replay-key-1' };
      const first = await svc.book(body, true, context);
      const second = await svc.book(body, true, context);
      expect('error' in first || 'error' in second).toBe(false);
      const all = await settled();
      expect(all.map((c) => [c.event, c.properties['channel']])).toEqual([['calendars_booking_created', 'api']]);
    });

    it('a team booking is about the host it was assigned to', async () => {
      const fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      const svc = service(fx);
      const team = await createTeam(db, accountId, { name: 'Analytics', slug: 'analytics-team' });
      if (!team.ok) throw new Error('team create failed');
      const ev = await createEventType(db, accountId, null, {
        slug: 'analytics-rr',
        title: 'Round robin',
        lengthMinutes: 30,
        schedulingType: 'round_robin',
        scheduleId: null,
        teamId: team.value.id,
      });
      if (!ev.ok) throw new Error('event create failed');
      for (const memberId of [alex, jordan]) {
        await db.run(
          sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
              VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, 0, NULL, 100, NULL, ${Date.now()})`,
        );
      }
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const avail = await svc.teamAvailability('acme', 'analytics-team', 'analytics-rr', from, to);
      const out = await svc.teamBook('acme', 'analytics-team', {
        slug: 'analytics-rr',
        startUtc: avail!.slots[0]!.startUtc,
        attendee: { name: 'Tia', email: 'tia@example.org', timeZone: 'UTC' },
      });
      expect('error' in out).toBe(false);
      await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
      const [c] = await captures();
      const host = (out as { hostMemberId: string }).hostMemberId === alex ? 'alex@example.com' : 'jordan@example.com';
      expect(c).toMatchObject({ distinctId: host, properties: { channel: 'booking_page', is_team: true } });
      expect(JSON.stringify(c)).not.toContain('tia@example.org');
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

    it('a 408 is retried; a row that cannot be read is skipped once', async () => {
      const { provider } = posthog(408);
      const fx = new AnalyticsEffects(db, provider, env(ON));
      await fx.hostEvent('hours_set', principal);
      await workerWith(db, fx).drainOnce();
      expect((await rows())[0]!.status).toBe('pending');

      await db.run(sql`UPDATE outbox SET payload = ${'not json'}, next_attempt_at = 0`);
      await workerWith(db, fx).drainOnce();
      const [row] = await rows();
      expect(row!.status).toBe('skipped');
      expect(row!.lastError).toMatch(/unreadable/);
    });

    it('an analytics row gets fewer attempts than the outbox default, so a hung vendor cannot hold mail', async () => {
      const fx = new AnalyticsEffects(db, recordingProvider(), env(ON));
      await fx.hostEvent('hours_set', principal);
      expect((await rows())[0]!.maxAttempts).toBe(3);
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

    const admin = (calendar: CalendarProvider = new DisabledCalendarProvider()) =>
      new AdminService(
        db,
        new CalendarEffects(calendar, db),
        new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        fx,
      );
    const host = () =>
      new HostController(admin(), new OnboardingService(db, undefined, growth), auth(), growth, undefined, fx);
    const crud = () => new AdminCrudController(db, auth(), growth, undefined, fx);

    it('choosing a template is the template and the first publish', async () => {
      await host().submitSetup(REQ, { templateId: '30min' });
      const names = (await settled()).map((c) => c.event);
      expect(names).toEqual(['calendars_template_chosen', 'calendars_event_type_published']);
      expect((await events())[0]![1]).toMatchObject({ template: '30min' });
    });

    it('a claimed signup source is recorded; a refused claim is not', async () => {
      await db.run(sql`UPDATE account SET created_at = ${Date.now() - 1000}, attribution = NULL WHERE id = ${accountId}`);
      await host().claimAttribution(REQ, { attribution: { utm_source: 'google' } });
      await host().claimAttribution(REQ, { attribution: { utm_source: 'bing' } });
      const recorded = (await settled())
        .filter((c) => c.event === 'calendars_attribution_captured')
        .map((c) => [c.event, c.properties] as const);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]![1]).toMatchObject({ utm_source: 'google' });
    });

    it('only a visible event type is a publish, and only the save that makes it visible', async () => {
      const base = { title: 'Demo', lengthMinutes: 30 };
      const hidden = await crud().createEventType(REQ, { ...base, slug: 'demo-hidden', hidden: true });
      await crud().createEventType(REQ, { ...base, slug: 'demo-visible' });
      await crud().updateEventType(REQ, (hidden as { id: string }).id, { title: 'Demo, renamed' });
      await crud().updateEventType(REQ, (hidden as { id: string }).id, { hidden: false });
      expect((await settled()).map((c) => [c.event, c.properties['source']])).toEqual([
        ['calendars_event_type_published', 'dashboard'],
        ['calendars_event_type_published', 'dashboard'],
      ]);
    });

    it('hours are set when the rules change, not by a rename that resends the same ones', async () => {
      const rules = [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null }];
      const created = (await crud().createSchedule(REQ, { name: 'Weekdays', timeZone: 'UTC', rules })) as { id: string };
      // The dashboard sends the rules with every save.
      await crud().updateSchedule(REQ, created.id, { name: 'Renamed', rules: [{ ...rules[0]!, days: [5, 4, 3, 2, 1] }] });
      await crud().updateSchedule(REQ, created.id, { rules: [{ ...rules[0]!, endTime: '18:00' }] });
      expect((await settled()).map((c) => [c.event, c.properties['created']])).toEqual([
        ['calendars_hours_set', true],
        ['calendars_hours_set', false],
      ]);
    });

    it('turning the branding off is recorded with its new state, once', async () => {
      await host().setBranding(REQ, { hideBranding: true });
      // Saving the same state again is not a toggle.
      await host().setBranding(REQ, { hideBranding: true });
      await host().setBranding(REQ, { hideBranding: false });
      expect((await settled()).map((c) => [c.event, c.properties['hidden']])).toEqual([
        ['calendars_hide_branding_toggled', true],
        ['calendars_hide_branding_toggled', false],
      ]);
    });

    it('a studio save names the settings that moved, never their values', async () => {
      await host().updateBranding(REQ, { brandColor: '#123456' });
      const all = await settled();
      expect(all).toHaveLength(1);
      const { event, properties: props } = all[0]!;
      expect(event).toBe('calendars_branding_changed');
      expect(props).toMatchObject({ change: 'page_style', fields: 'brandColor' });
      expect(JSON.stringify(props)).not.toContain('#123456');
    });
    it('the brand kit, applying it and reverting it are each a branding change', async () => {
      await host().putBrandKit(REQ, { accent: '#2f6fed', theme: 'light' });
      await host().applyBrandKit(REQ);
      await host().revertBranding(REQ);
      expect((await settled()).map((c) => c.properties['change'])).toEqual(['brand_kit', 'kit_applied', 'reverted']);
    });

    it('a manual connection is recorded with a label, never free text', async () => {
      await host().createConnection(REQ, { provider: 'Generic', externalId: 'ext-1' });
      await host().createConnection(REQ, { provider: 'a provider; DROP TABLE', externalId: 'ext-2' });
      expect((await settled()).map((c) => [c.properties['provider'], c.properties['method']])).toEqual([
        ['generic', 'manual'],
        ['other', 'manual'],
      ]);
    });

    it('the connect flow records a connection once, however often the popup polls', async () => {
      const connector = {
        enabled: true,
        name: 'connector',
        startConnect: async () => ({ token: 't', connectUrl: 'https://connect.example.test' }),
        discoverConnections: async () => [
          { connectionRef: 'conn-A', provider: 'google', primaryEmail: 'alex@example.com', connected: true },
        ],
        listCalendars: async () => [],
      } as unknown as CalendarProvider;
      const ctrl = new HostController(admin(connector), new OnboardingService(db, undefined, growth), auth(), growth, undefined, fx);
      await ctrl.discoverConnections(REQ, { provider: 'google' });
      await ctrl.discoverConnections(REQ, { provider: 'google' });
      expect((await settled()).map((c) => [c.event, c.properties['provider'], c.properties['method']])).toEqual([
        ['calendars_calendar_connected', 'google', 'connect_flow'],
      ]);
    });

    it('a host-made booking is channel host', async () => {
      const startUtc = await getAvailabilityFor(db);
      await host().hostCreate(REQ, {
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc,
        attendee: { name: 'Hal', email: 'hal@example.org', timeZone: 'UTC' },
        answers: { company: 'Hal Co' },
      } as never);
      const all = await settled();
      expect(all.map((c) => [c.event, c.properties['channel']])).toEqual([['calendars_booking_created', 'host']]);
      expect(JSON.stringify(all)).not.toContain('hal@example.org');
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

    it('parallel first logins report one signup: only the request whose insert won', async () => {
      const seen: SignupNotice[] = [];
      const provider = new WorkOsAuthProvider(db, { JWT_SECRET: SECRET }, (s) => void seen.push(s));
      const token = mint({ account_id: 'ext_par', sub: 'ext_par_u', email: 'par@x.io' });
      await Promise.all([1, 2, 3, 4].map(() => provider.resolveHost(bearer(token))));
      expect(seen).toHaveLength(1);
    });

    it('parallel first logins of an invitee report one adoption', async () => {
      const seen: SignupNotice[] = [];
      const provider = new WorkOsAuthProvider(db, { JWT_SECRET: SECRET }, (s) => void seen.push(s));
      await provider.resolveHost(bearer(mint({ account_id: 'ext_inv', sub: 'owner', email: 'owner@x.io' })));
      const acct = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE external_id = 'ext_inv'`))!.id;
      await db.run(
        sql`INSERT INTO member (id, account_id, email, role, status, created_at)
            VALUES ('invited-par', ${acct}, 'guest@x.io', 'member', 'invited', ${Date.now()})`,
      );
      const token = mint({ account_id: 'ext_inv', sub: 'guest', email: 'guest@x.io' });
      const ids = await Promise.all([1, 2, 3].map(() => provider.resolveHost(bearer(token))));
      expect(new Set(ids.map((p) => p.memberId))).toEqual(new Set(['invited-par']));
      expect(seen.filter((s) => s.fromInvite)).toHaveLength(1);
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
