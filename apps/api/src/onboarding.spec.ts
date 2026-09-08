import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { CalendarEffects } from './calendar-effects';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import { OnboardingService } from './onboarding.service';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

/**
 * The onboarding surface end-to-end through the controller: the gates on
 * /v1/me, the wizard payload, both submissions, and the corrected "Get
 * bookable" checklist.
 */
describe('onboarding surface (two gates)', () => {
  let db: Db;
  let ctrl: HostController;
  let admin: AdminService;
  let onboarding: OnboardingService;
  let accountId: string;
  let alex: string;
  let jordan: string;
  let principal: HostPrincipal;

  const REQ = {} as ReqLike;
  const as = (p: HostPrincipal) => {
    principal = p;
  };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle='alex-rivera'`,
    ))!.id;
    jordan = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle='jordan-lee'`,
    ))!.id;

    admin = new AdminService(
      db,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
    onboarding = new OnboardingService(db);
    const auth = { resolveHost: async () => principal } as unknown as AuthService;
    ctrl = new HostController(admin, onboarding, auth);
    as({ accountId, memberId: alex, role: 'owner' });
  });

  // --- The gates on /v1/me ------------------------------------------------

  it('owes nothing to the seeded owner', async () => {
    expect(await ctrl.me(REQ)).toMatchObject({
      onboardingRequired: false,
      setupRequired: false,
    });
  });

  // The live bug #84 is about: bookable-looking, publicly empty.
  it('owes SETUP to the seeded member whose only event is the team’s', async () => {
    as({ accountId, memberId: jordan, role: 'member' });
    expect(await ctrl.me(REQ)).toMatchObject({
      onboardingRequired: false,
      setupRequired: true,
    });
  });

  // BARE FORK. Qualification exists to feed a growth funnel; a self-hoster has
  // none, so asking would trap their first admin behind six commercial
  // questions before they could reach their own dashboard. Gate 2 still
  // applies — a first event type is product value every deployment wants.
  it('never owes qualification when the deployment has no upstream', async () => {
    const fork = new HostController(
      admin,
      new OnboardingService(db, { ONBOARDING_IAM_BASE_URL: undefined } as never),
      { resolveHost: async () => principal } as unknown as AuthService,
    );
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);

    expect(await fork.me(REQ)).toMatchObject({
      onboardingRequired: false,
      setupRequired: true,
    });
    const state = await fork.onboardingState(REQ);
    expect(state.onboardingRequired).toBe(false);
    expect(state.questionKeys).toEqual([]);
    expect(state.templates).toHaveLength(4);
  });

  it('owes qualification once an upstream IS configured', async () => {
    const cloud = new HostController(
      admin,
      new OnboardingService(db, {
        ONBOARDING_IAM_BASE_URL: 'https://identity.example',
      } as never),
      { resolveHost: async () => principal } as unknown as AuthService,
    );
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    expect(await cloud.me(REQ)).toMatchObject({ onboardingRequired: true });
  });

  it('owes BOTH to the owner of a brand-new account', async () => {
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);
    expect(await ctrl.me(REQ)).toMatchObject({
      onboardingRequired: true,
      setupRequired: true,
    });
  });

  // --- The wizard payload -------------------------------------------------

  // With the gate owed but nothing to probe (an upstream is configured, this
  // member has no upstream identity), the probe reports `not_configured` and
  // the cohort falls to the short one — the fail-closed direction. `cold` is
  // reached only on a definitive upstream miss, which is covered as a pure
  // unit in @slate/engine rather than by mocking fetch here.
  it('asks the SHORT bank when the gate is owed but nothing can be probed', async () => {
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    const cloud = new HostController(
      admin,
      new OnboardingService(db, {
        ONBOARDING_IAM_BASE_URL: 'https://identity.example',
      } as never),
      { resolveHost: async () => principal } as unknown as AuthService,
    );
    const state = await cloud.onboardingState(REQ);
    expect(state.onboardingRequired).toBe(true);
    expect(state.cohort).toBe('dapta');
    expect(state.questionKeys).toEqual(['phone', 'use_case']);
  });

  // Claiming a question set nobody probed for would be the same species of lie
  // this ticket exists to remove.
  it('asks NOTHING once qualification is settled', async () => {
    const state = await ctrl.onboardingState(REQ);
    expect(state.onboardingRequired).toBe(false);
    expect(state.questionKeys).toEqual([]);
  });

  it('always offers the four templates with localized copy', async () => {
    const state = await ctrl.onboardingState(REQ);
    expect(state.templates.map((t) => t.id)).toEqual(['30min', '15min', '45min', '60min']);
    expect(state.templates.every((t) => t.title.length > 0)).toBe(true);
  });

  it('serves Spanish copy to a Spanish member', async () => {
    await db.run(sql`UPDATE member SET locale = 'es' WHERE id = ${alex}`);
    const state = await ctrl.onboardingState(REQ);
    expect(state.templates.find((t) => t.id === '30min')?.title).toBe('Reunión de 30 minutos');
  });

  // --- Gate 1 -------------------------------------------------------------

  it('rejects a plain member submitting the workspace’s qualification', async () => {
    as({ accountId, memberId: jordan, role: 'member' });
    await expect(
      ctrl.submitQualification(REQ, { answers: { phone: '+1 555' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a key outside the shared bank', async () => {
    await expect(
      ctrl.submitQualification(REQ, { answers: { nonsense: 'x' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('claims once and refuses to overwrite on a second submission', async () => {
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    expect(await ctrl.submitQualification(REQ, { answers: { industry: 'saas' } })).toMatchObject({
      claimed: true,
    });
    expect(await ctrl.submitQualification(REQ, { answers: { industry: 'retail' } })).toMatchObject({
      claimed: false,
    });
    const row = await db.get<{ onboarding: string }>(
      sql`SELECT onboarding FROM account WHERE id = ${accountId}`,
    );
    expect(JSON.parse(row!.onboarding)).toEqual({ industry: 'saas' });
  });

  // --- Gate 2 -------------------------------------------------------------

  it('creates the host’s first event type from a named template', async () => {
    as({ accountId, memberId: jordan, role: 'member' });
    const created = await ctrl.submitSetup(REQ, { templateId: '45min' });
    expect(created).toMatchObject({ slug: 'demo', lengthMinutes: 45 });
    expect(await ctrl.me(REQ)).toMatchObject({ setupRequired: false });
  });

  it('refuses a template id that is not in the registry', async () => {
    await expect(ctrl.submitSetup(REQ, { templateId: '90min' as never })).rejects.toMatchObject({
      status: 400,
    });
  });

  // A hostile client may name a template; it may never describe one.
  it('ignores any config the client tries to smuggle alongside the id', async () => {
    as({ accountId, memberId: jordan, role: 'member' });
    const created = await ctrl.submitSetup(REQ, {
      templateId: '15min',
      lengthMinutes: 999,
      title: 'PWNED',
      hidden: true,
    } as never);
    expect(created).toMatchObject({ lengthMinutes: 15, title: 'Quick call' });
  });

  it('suffixes rather than fails when the host already owns the slug', async () => {
    as({ accountId, memberId: jordan, role: 'member' });
    const first = await ctrl.submitSetup(REQ, { templateId: '45min' });
    const second = await ctrl.submitSetup(REQ, { templateId: '45min' });
    expect(first.slug).toBe('demo');
    expect(second.slug).toBe('demo-2');
  });

  // --- The corrected checklist -------------------------------------------

  it('reports the checklist on published event types, not on the handle', async () => {
    expect(await ctrl.setupStatus(REQ)).toMatchObject({ hasPublishedEventType: true });

    // Jordan HAS a handle and a public page — and nothing to book on it.
    as({ accountId, memberId: jordan, role: 'member' });
    const status = await ctrl.setupStatus(REQ);
    expect(status).toMatchObject({ hasPublishedEventType: false });
    expect(status).not.toHaveProperty('hasBookingLink');

    const me = await ctrl.me(REQ);
    expect(me!.handle).toBe('jordan-lee'); // the old check would have said "done"
  });

  it('re-opens the setup gate when the host deletes their last event type', async () => {
    expect(await ctrl.me(REQ)).toMatchObject({ setupRequired: false });
    await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);
    expect(await ctrl.me(REQ)).toMatchObject({ setupRequired: true });
  });

  it('never counts another member’s event types toward this host', async () => {
    as({ accountId, memberId: randomUUID(), role: 'member' });
    expect(await ctrl.setupStatus(REQ)).toMatchObject({ hasPublishedEventType: false });
  });
});
