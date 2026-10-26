import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Logger } from '@nestjs/common';
import { createBooking, createDb, getAvailability, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { ENTITLEMENT_TTL_MS } from '@slate/shared';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { EntitlementGate } from './entitlement-gate';
import { AdminService } from './admin.service';
import { BookingService } from './booking.service';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal } from './auth.service';
import type { EntitlementAnswer, EntitlementsProvider } from './entitlements.provider';

/**
 * A paying Dapta AI customer can turn the Dapta branding off on their public
 * pages; the branding is on by default and comes back by itself when the
 * subscription lapses.
 *
 * The upstream entitlement service is a stub here (no vendor call is ever
 * made), and the clock is moved by hand to prove the one number the PR body
 * states: how long after a lapse the branding returns.
 */

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** The upstream, as a switch the test flips. Counts its calls. */
class Upstream implements EntitlementsProvider {
  readonly enabled = true;
  calls = 0;
  /** An outage: the adapter's `unknown`, or a provider that breaks its contract and throws. */
  failing: null | 'unknown' | 'throw' = null;
  constructor(public paid: boolean) {}
  verdict(): Promise<EntitlementAnswer> {
    this.calls++;
    if (this.failing === 'throw') return Promise.reject(new Error('upstream exploded'));
    if (this.failing === 'unknown') return Promise.resolve('unknown');
    return Promise.resolve(this.paid ? 'paid' : 'free');
  }
}

class FakeAuth {
  current: HostPrincipal = { accountId: '', memberId: '', role: 'member' };
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

/** Let a refresh started on the side run to the end. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

describe('hiding the Dapta branding (included with a paying Dapta AI subscription)', () => {
  let db: Db;
  let accountId: string;
  let owner: HostPrincipal;
  let member: HostPrincipal;
  let upstream: Upstream;

  // One gate per mode, shared by every service in a test, as the app shares
  // its one ENTITLEMENT_GATE.
  let gates: Partial<Record<'open' | 'locked', EntitlementGate>>;
  const gateFor = (mode: 'open' | 'locked') => (gates[mode] ??= new EntitlementGate(db, upstream, mode));
  const admin = (mode: 'open' | 'locked' = 'locked') =>
    new AdminService(
      db,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
      upstream,
      mode,
      undefined,
      undefined,
      gateFor(mode),
    );
  const booking = (mode: 'open' | 'locked' = 'locked') =>
    new BookingService(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
      undefined,
      upstream,
      mode,
      gateFor(mode),
    );
  const profileShows = async (svc: BookingService) => (await svc.profile('acme', 'alex-rivera'))!.showBranding;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    const jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    owner = { accountId, memberId: alex, role: 'owner' };
    member = { accountId, memberId: jordan, role: 'member' };
    upstream = new Upstream(true);
    gates = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is on by default: a new account shows the branding and stores no choice', async () => {
    expect(await admin().brandingStatus(owner)).toEqual({ hideBranding: false, canHide: true, showing: true });
    expect(await profileShows(booking())).toBe(true);
    const row = await db.get<{ hide_branding: number }>(sql`SELECT hide_branding FROM account WHERE id = ${accountId}`);
    expect(Number(row!.hide_branding)).toBe(0);
  });

  it('a paying customer turns it off, and every public payload says so', async () => {
    const out = await admin().setBranding(owner, true);
    expect(out).toEqual({ ok: true, branding: { hideBranding: true, canHide: true, showing: false } });

    const svc = booking();
    expect(await profileShows(svc)).toBe(false);
    expect((await svc.teamProfile('acme', 'sales'))!.showBranding).toBe(false);

    // The manage page of a booking on this account.
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: T0,
      toMs: T0 + 14 * 86_400_000,
    });
    const made = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: new Date(avail!.slots[0]!.startUtc).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    expect(made.ok).toBe(true);
    const { booking: b, manageToken } = made as { booking: { uid: string }; manageToken: string };
    expect(await svc.manageView(b.uid, manageToken)).toMatchObject({ showBranding: false });

    // Turning it back on never needs the subscription.
    upstream.paid = false;
    await admin().setBranding(owner, false);
    expect(await profileShows(svc)).toBe(true);
    expect(await svc.manageView(b.uid, manageToken)).toMatchObject({ showBranding: true });
  });

  it('a customer who is not paying cannot turn it off, and the page keeps the branding', async () => {
    upstream.paid = false;
    expect(await admin().brandingStatus(owner)).toEqual({ hideBranding: false, canHide: false, showing: true });
    expect(await admin().setBranding(owner, true)).toEqual({ ok: false, reason: 'NOT_ENTITLED' });
    expect(await profileShows(booking())).toBe(true);
  });

  it('an open deployment (the OSS default) gives the switch to everyone, with no upstream at all', async () => {
    upstream.paid = false;
    expect(await admin('open').setBranding(owner, true)).toMatchObject({ ok: true });
    expect(await profileShows(booking('open'))).toBe(false);
    expect(upstream.calls).toBe(0);
  });

  it('the public path never waits on the upstream: it decides from the cache', async () => {
    await admin().setBranding(owner, true); // one inline check, verdict cached as paid
    const calls = upstream.calls;
    const svc = booking();
    for (let i = 0; i < 5; i++) expect(await profileShows(svc)).toBe(false);
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS - 1);
    expect(await profileShows(svc)).toBe(false);
    await settle();
    expect(upstream.calls).toBe(calls);
  });

  it('a lapsed subscription brings the branding back within one TTL (6 h) of the last paid check, with nobody logging in', async () => {
    expect(ENTITLEMENT_TTL_MS).toBe(6 * 3_600_000);
    await admin().setBranding(owner, true); // verdict 'paid', checked at T0
    const svc = booking();
    expect(await profileShows(svc)).toBe(false);

    // The subscription lapses one minute later. The cache does not know yet.
    upstream.paid = false;
    vi.setSystemTime(T0 + 60_000);
    expect(await profileShows(svc)).toBe(false);
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS - 1);
    expect(await profileShows(svc)).toBe(false);

    // One TTL after the last check: the first visit still renders from the
    // cache and queues the refresh on the side; the refresh lands, and the
    // very next visit carries the branding again.
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS);
    const calls = upstream.calls;
    expect(await profileShows(svc)).toBe(false);
    await settle();
    expect(upstream.calls).toBe(calls + 1);
    expect(await profileShows(svc)).toBe(true);

    // The choice is kept: the settings show it greyed as lapsed.
    expect(await admin().brandingStatus(owner)).toEqual({ hideBranding: true, canHide: false, showing: true });

    // Re-subscribing gives the choice back untouched, within the next TTL.
    upstream.paid = true;
    vi.setSystemTime(T0 + 2 * ENTITLEMENT_TTL_MS);
    expect(await profileShows(svc)).toBe(true);
    await settle();
    expect(await profileShows(svc)).toBe(false);
  });

  it('a burst of visits on a stale verdict makes one upstream call, not one per visit', async () => {
    await admin().setBranding(owner, true);
    const calls = upstream.calls;
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 1);
    const svc = booking();
    await Promise.all(Array.from({ length: 8 }, () => profileShows(svc)));
    await settle();
    expect(upstream.calls).toBe(calls + 1);
  });

  it('an account that shows the branding never asks the upstream from a public page', async () => {
    vi.setSystemTime(T0 + 10 * ENTITLEMENT_TTL_MS);
    expect(await profileShows(booking())).toBe(true);
    await settle();
    expect(upstream.calls).toBe(0);
  });

  it('logs one line when the verdict flips, naming the account id and never the email', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await admin().setBranding(owner, true); // null -> paid: a first answer, not a flip
    expect(log).not.toHaveBeenCalled();

    upstream.paid = false;
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS);
    await profileShows(booking());
    await settle();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('paid -> free');
    expect(line).toContain(accountId);
    expect(line).not.toMatch(/@/);

    // Back to paid is a flip too; an unchanged answer is not.
    upstream.paid = true;
    vi.setSystemTime(T0 + 2 * ENTITLEMENT_TTL_MS);
    await profileShows(booking());
    await settle();
    vi.setSystemTime(T0 + 3 * ENTITLEMENT_TTL_MS);
    await profileShows(booking());
    await settle();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1]![0])).toContain('free -> paid');
  });

  it("an upstream that cannot answer never shows a paying host's branding again, nor says it lapsed", async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await admin().setBranding(owner, true); // paid at T0
    const svc = booking();
    const settings = admin();

    // The upstream goes down (a timeout or a 5xx: the adapter's `unknown`).
    upstream.failing = 'unknown';
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS);
    const calls = upstream.calls;
    expect(await profileShows(svc)).toBe(false);
    await settle();
    expect(upstream.calls).toBe(calls + 1);
    // The previous verdict stands: the page stays clean, Settings says "off"
    // (not lapsed), and nothing flipped.
    expect(await profileShows(svc)).toBe(false);
    expect(await settings.brandingStatus(owner)).toEqual({ hideBranding: true, canHide: true, showing: false });
    expect(log).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain(accountId);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/@/);

    // It backs off instead of asking on every visit: nothing for the first minute.
    for (let i = 0; i < 5; i++) await profileShows(svc);
    await settings.brandingStatus(owner);
    await settle();
    expect(upstream.calls).toBe(calls + 1);
    // Then one more try, and the wait doubles.
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 60_000);
    await profileShows(svc);
    await settle();
    expect(upstream.calls).toBe(calls + 2);
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 60_000 + 119_999);
    await profileShows(svc);
    await settle();
    expect(upstream.calls).toBe(calls + 2);

    // The upstream recovers with a real lapse: that one counts.
    upstream.failing = null;
    upstream.paid = false;
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 180_000);
    await profileShows(svc);
    await settle();
    expect(await profileShows(svc)).toBe(true);
    expect(String(log.mock.calls[0]![0])).toContain('paid -> free');
  });

  it('a provider that throws: the pages show the branding, Settings still answers, and it backs off', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await admin().setBranding(owner, true);
    const svc = booking();
    upstream.failing = 'throw';
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS);
    const calls = upstream.calls;
    expect(await profileShows(svc)).toBe(false); // this visit rendered from the cache
    await settle();
    // Fail closed on the public side, until an answer lands.
    expect(await profileShows(svc)).toBe(true);
    // Settings answers (no 500) and does not call it a lapse.
    const status = await admin().brandingStatus(owner);
    expect(status.canHide).toBe(true);
    expect(status.hideBranding).toBe(true);
    // One call, not one per visit.
    for (let i = 0; i < 5; i++) await profileShows(svc);
    await settle();
    expect(upstream.calls).toBe(calls + 1);

    // A good answer clears it.
    upstream.failing = null;
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 60_000);
    await profileShows(svc);
    await settle();
    expect(await profileShows(svc)).toBe(false);
  });

  it("the invitee's email follows the same switch, decided when the mail is sent", async () => {
    const sent: string[] = [];
    const provider = {
      send: (m: { html?: string }) => {
        sent.push(m.html ?? '');
        return Promise.resolve({ delivered: false, driver: 'log-only' as const });
      },
    };
    const email = new EmailEffects(
      new BookingNotifier(provider as never, { signupUrl: 'https://signup.example.test/' }),
      db,
      undefined,
      undefined,
      undefined,
      upstream,
      'locked',
      gateFor('locked'),
    );
    // A queued row as the enqueue side snapshots it, here with a stale
    // `showBranding: false`: delivery reads the account, never the snapshot.
    const row = JSON.stringify({
      accountId,
      uid: 'bk_branding_mail',
      title: 'Intro call',
      startUtc: '2026-10-20T15:00:00.000Z',
      endUtc: '2026-10-20T15:30:00.000Z',
      host: { name: 'Alex Rivera', email: 'host@example.test' },
      attendee: { name: 'Sam Guest', email: 'guest@example.test', timeZone: 'UTC' },
      audience: 'attendee',
      showBranding: false,
    });
    const madeWith = () => sent.at(-1)!.includes('Made with dCal.ai by Dapta');

    await email.deliver('confirmation', row);
    expect(madeWith()).toBe(true); // on by default

    await admin().setBranding(owner, true); // paying, switched off
    await email.deliver('confirmation', row);
    expect(madeWith()).toBe(false);
    expect(sent.at(-1)).not.toContain('https://signup.example.test/');

    // A lapse: the row sent after the refresh lands carries the line again,
    // and the send itself never waited on the upstream.
    upstream.paid = false;
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS);
    const calls = upstream.calls;
    await email.deliver('reminder', row);
    expect(madeWith()).toBe(false);
    await settle();
    expect(upstream.calls).toBe(calls + 1);
    await email.deliver('reminder', row);
    expect(madeWith()).toBe(true);
  });

  describe('the settings routes', () => {
    let auth: FakeAuth;
    let host: HostController;
    beforeEach(() => {
      auth = new FakeAuth();
      host = new HostController(admin(), {} as never, auth as unknown as AuthService, {} as never);
    });

    it('every role reads it; a member cannot change it', async () => {
      auth.current = member;
      expect(await host.brandingStatus({} as never)).toMatchObject({ hideBranding: false, showing: true });
      await expect(host.setBranding({} as never, { hideBranding: true })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('an owner changes it; without the subscription the answer is 403 and nothing is stored', async () => {
      auth.current = owner;
      expect(await host.setBranding({} as never, { hideBranding: true })).toEqual({
        hideBranding: true,
        canHide: true,
        showing: false,
      });

      await db.run(sql`UPDATE account SET hide_branding = 0, dapta_entitlement = 'free' WHERE id = ${accountId}`);
      await expect(host.setBranding({} as never, { hideBranding: true })).rejects.toMatchObject({
        response: { error: 'DAPTA_SUBSCRIPTION_REQUIRED' },
      });
      const row = await db.get<{ hide_branding: number }>(sql`SELECT hide_branding FROM account WHERE id = ${accountId}`);
      expect(Number(row!.hide_branding)).toBe(0);
    });

    it('refuses a body that is not a boolean', async () => {
      auth.current = owner;
      await expect(host.setBranding({} as never, { hideBranding: 'yes' })).rejects.toMatchObject({
        response: { error: 'BAD_REQUEST' },
      });
    });
  });
});
