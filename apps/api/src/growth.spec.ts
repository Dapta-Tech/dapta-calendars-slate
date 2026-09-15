import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, listOutbox, migrate, seed, sql, type Db, type OutboxKind, type OutboxRow } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { ATTRIBUTION_WINDOW_MS } from '@slate/shared';
import { CalendarEffects } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import { GrowthService } from './growth.service';
import { OnboardingService } from './onboarding.service';
import { OutboxWorker } from './outbox.worker';
import { AdminCrudController } from './admin-crud.controller';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

/**
 * O2 growth end-to-end through the two seams that matter: what gets ENQUEUED
 * (never called inline — invariant 5), and what the worker then SENDS.
 *
 * The load-bearing assertion in the enqueue half is always the same pair: the
 * rows now in `outbox`, and that `fetch` was never touched. That is how
 * "no request handler calls the CRM" gets a test rather than a promise.
 */
describe('O2 growth (#94)', () => {
  let db: Db;
  let growth: GrowthService;
  let accountId: string;
  let alex: string;
  let principal: HostPrincipal;

  const REQ = {} as ReqLike;
  const auth = () => ({ resolveHost: async () => principal }) as unknown as AuthService;

  const rows = async (kind?: OutboxKind): Promise<OutboxRow[]> =>
    (await listOutbox(db, kind ? { kind } : {})) as OutboxRow[];
  const body = (r: OutboxRow) => JSON.parse(r.payload ?? '{}') as Record<string, unknown>;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle='alex-rivera'`,
    ))!.id;
    growth = new GrowthService(db);
    principal = { accountId, memberId: alex, role: 'owner' };
    // Gate 1 unclaimed, so the qualification path is reachable.
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
  });

  // --- The claim, and its one shared constant -----------------------------

  describe('attribution claim', () => {
    const ctrl = () =>
      new HostController(
        new AdminService(
          db,
          new CalendarEffects(new DisabledCalendarProvider(), db),
          new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
        ),
        new OnboardingService(db, undefined, growth),
        auth(),
        growth,
      );

    async function ageAccount(ms: number): Promise<void> {
      await db.run(sql`UPDATE account SET created_at = ${Date.now() - ms} WHERE id = ${accountId}`);
    }

    it('claims a campaign onto a young account', async () => {
      await ageAccount(1000);
      const r = await ctrl().claimAttribution(REQ, {
        attribution: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'q3' },
      });
      expect(r).toEqual({ claimed: true });
    });

    /**
     * The ten minutes have exactly ONE definition. `@slate/db` deliberately
     * carries no attribution policy — it takes an absolute cutoff — so this is
     * where the service's use of `ATTRIBUTION_WINDOW_MS` is pinned to the
     * database behaviour it produces.
     */
    it('refuses an account just outside ATTRIBUTION_WINDOW_MS', async () => {
      await ageAccount(ATTRIBUTION_WINDOW_MS + 5_000);
      expect(await ctrl().claimAttribution(REQ, { attribution: { utm_source: 'google' } })).toEqual({
        claimed: false,
      });
    });

    it('accepts an account just inside it', async () => {
      await ageAccount(ATTRIBUTION_WINDOW_MS - 5_000);
      expect(await ctrl().claimAttribution(REQ, { attribution: { utm_source: 'google' } })).toEqual({
        claimed: true,
      });
    });

    it('refuses a second claim — first touch wins, permanently', async () => {
      await ageAccount(1000);
      await ctrl().claimAttribution(REQ, { attribution: { utm_source: 'google' } });
      expect(
        await ctrl().claimAttribution(REQ, { attribution: { utm_source: 'facebook' } }),
      ).toEqual({ claimed: false });

      const stored = await db.get<{ attribution: string }>(
        sql`SELECT attribution FROM account WHERE id = ${accountId}`,
      );
      expect(JSON.parse(stored!.attribution)).toEqual({ utm_source: 'google' });
    });

    it('rejects a key outside the allowlist rather than storing it', async () => {
      // The claim is write-once, so an unknown key would be permanent. The
      // parser already drops it; the contract says so again at the boundary.
      await ageAccount(1000);
      await expect(
        ctrl().claimAttribution(REQ, { attribution: { utm_source: 'g', utm_evil: 'x' } }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects an empty blob', async () => {
      await ageAccount(1000);
      await expect(ctrl().claimAttribution(REQ, { attribution: {} })).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  // --- The early fire ------------------------------------------------------

  describe('the early push', () => {
    it('enqueues one dapta_sync row and calls nothing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(await growth.enqueueEarly(principal)).toEqual({ enqueued: true });

      const enqueued = await rows('dapta_sync');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.action).toBe('early');
      expect(enqueued[0]!.accountId).toBe(accountId);
      expect(body(enqueued[0]!)).toMatchObject({ entry_type: 'self_serve', account_id: accountId });
      // Invariant 5, asserted rather than asserted-about.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('never pushes the same lead twice, however often the wizard reopens', async () => {
      await growth.enqueueEarly(principal);
      expect(await growth.enqueueEarly(principal)).toEqual({ enqueued: false });
      expect(await rows('dapta_sync')).toHaveLength(1);
    });

    it('carries no lead_source — no qualification answer exists yet', async () => {
      await growth.enqueueEarly(principal);
      expect(body((await rows('dapta_sync'))[0]!)).not.toHaveProperty('lead_source');
    });

    it('still enqueues for a member with no email, so the drop is visible', async () => {
      // Dropping it at the enqueue site would leave no row and no trace. The
      // row exists, the worker marks it skipped with a reason, and the operator
      // can see the un-upsertable contact in the delivery log.
      await db.run(sql`UPDATE member SET email = NULL WHERE id = ${alex}`);
      expect(await growth.enqueueEarly(principal)).toEqual({ enqueued: true });
      expect(await rows('dapta_sync')).toHaveLength(1);
    });
  });

  // --- Qualification: two rows, and only for the winner --------------------

  describe('the qualification push', () => {
    const onboarding = () => new OnboardingService(db, undefined, growth);

    it('enqueues the contact AND the lead score when the claim is won', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const r = await onboarding().submitQualification(principal, {
        answers: { phone: '+1 555 0100', lead_source: 'referral' },
      });
      expect(r.claimed).toBe(true);

      const sync = await rows('dapta_sync');
      expect(sync.map((x) => x.action)).toEqual(['complete']);
      const iam = await rows('iam_onboarding');
      expect(iam.map((x) => x.action)).toEqual(['responses']);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('carries lead_source only because a real answer exists', async () => {
      await onboarding().submitQualification(principal, {
        answers: { phone: '+1 555 0100', lead_source: 'referral' },
      });
      expect(body((await rows('dapta_sync'))[0]!)).toMatchObject({
        lead_source: 'referral',
        entry_type: 'self_serve',
      });
    });

    it('omits lead_source entirely when the bank did not include it', async () => {
      // Absent, not null and not empty: a field that is absent cannot overwrite
      // a better value already on the contact.
      await onboarding().submitQualification(principal, { answers: { phone: '+1 555 0100' } });
      expect(body((await rows('dapta_sync'))[0]!)).not.toHaveProperty('lead_source');
    });

    it('attaches the claimed attribution to the completion push', async () => {
      await db.run(sql`UPDATE account SET created_at = ${Date.now()} WHERE id = ${accountId}`);
      await growth.claim(principal, { utm_source: 'google', utm_campaign: 'q3' });
      await onboarding().submitQualification(principal, { answers: { phone: '+1 555 0100' } });
      expect(body((await rows('dapta_sync'))[0]!).params).toEqual({
        utm_source: 'google',
        utm_campaign: 'q3',
      });
    });

    /**
     * The duplicate-lead-score guard, stated as a test. O1 corrected
     * `claimQualification` to report the winner from an affected-row count for
     * exactly this: a losing submission that still enqueued would be a second
     * score for one workspace.
     */
    it('enqueues NOTHING for a submission that lost the claim', async () => {
      await onboarding().submitQualification(principal, { answers: { phone: '+1 555 0100' } });
      const before = (await rows()).length;

      const second = await onboarding().submitQualification(principal, {
        answers: { phone: '+1 555 0199' },
      });
      expect(second.claimed).toBe(false);
      expect((await rows()).length).toBe(before);
    });
  });

  // --- The invited member --------------------------------------------------

  describe('an invited member', () => {
    const crud = () => new AdminCrudController(db, auth(), growth);

    it('reaches the CRM marked workspace_invite, with no IAM row', async () => {
      await crud().inviteMember(REQ, { email: 'newhost@example.com', role: 'member' });

      const sync = await rows('dapta_sync');
      expect(sync.map((x) => x.action)).toEqual(['member_invite']);
      const payload = body(sync[0]!);
      expect(payload).toMatchObject({
        entry_type: 'workspace_invite',
        email: 'newhost@example.com',
        account_id: accountId,
      });
      // Constraint 2: no answers exist, so a lead score would be garbage
      // indistinguishable from a real lead that scored low.
      expect(await rows('iam_onboarding')).toHaveLength(0);
    });

    it('never carries lead_source — an invite must not destroy earlier attribution', async () => {
      // The CRM upsert is by email. An invitee already known from a campaign
      // keeps the better attribution they already have.
      await crud().inviteMember(REQ, { email: 'newhost@example.com', role: 'member' });
      const payload = body((await rows('dapta_sync'))[0]!);
      expect(payload).not.toHaveProperty('lead_source');
      expect(payload).not.toHaveProperty('params');
    });

    it('fires when the membership row is created, before any setup', async () => {
      // The invitee this exists to capture is precisely the one who never
      // finishes. They have no upstream identity yet, so `user_id` is null.
      await crud().inviteMember(REQ, { email: 'newhost@example.com', role: 'member' });
      expect(body((await rows('dapta_sync'))[0]!).user_id).toBeNull();
    });

    it('still creates the member when the growth push cannot be enqueued', async () => {
      const broken = {
        enqueueMemberInvite: () => Promise.reject(new Error('boom')),
      } as unknown as GrowthService;
      const created = await new AdminCrudController(db, auth(), broken).inviteMember(REQ, {
        email: 'newhost@example.com',
        role: 'member',
      });
      expect(created.email).toBe('newhost@example.com');
    });
  });

  // --- The worker: what actually leaves ------------------------------------

  describe('delivery', () => {
    const ENV = {
      OUTBOX_WORKER_ENABLED: false,
      NODE_ENV: 'test',
      OUTBOX_POLL_MS: 1000,
      DAPTA_SYNC_URL: 'https://sync.example/contact',
      DAPTA_SYNC_TOKEN: 'tok',
      DAPTA_SYNC_TIMEOUT_MS: 5000,
      ONBOARDING_IAM_BASE_URL: 'https://identity.example',
      ONBOARDING_IAM_TOKEN: 'iam-tok',
    } as never;

    function workerWith(env: unknown, fetchImpl: typeof fetch) {
      const effects = new DaptaSyncEffects(env as never);
      effects.fetchImpl = fetchImpl;
      return new OutboxWorker(
        db,
        env as never,
        new CalendarEffects(new DisabledCalendarProvider(), db),
        new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
        effects,
      );
    }

    const ok = () => Promise.resolve(new Response('{}', { status: 200 }));

    it('posts the contact to the configured destination and marks the row done', async () => {
      const calls: Array<[string, RequestInit | undefined]> = [];
      const worker = workerWith(ENV, ((url: string, init?: RequestInit) => {
        calls.push([url, init]);
        return ok();
      }) as unknown as typeof fetch);

      await growth.enqueueEarly(principal);
      await worker.drainOnce();

      expect(calls[0]![0]).toBe('https://sync.example/contact');
      expect((await rows('dapta_sync'))[0]!.status).toBe('done');
    });

    it('posts the lead score to the identity service, not to the CRM', async () => {
      const urls: string[] = [];
      const worker = workerWith(ENV, ((url: string) => {
        urls.push(url);
        return ok();
      }) as unknown as typeof fetch);

      await new OnboardingService(db, undefined, growth).submitQualification(principal, {
        answers: { phone: '+1 555 0100' },
      });
      await worker.drainOnce();

      expect(urls).toContain('https://sync.example/contact');
      expect(urls).toContain('https://identity.example/onboarding/responses');
    });

    it('SKIPS rather than fails when no destination is configured (a bare fork)', async () => {
      // A self-hoster reports nothing to Dapta, and the delivery log says so
      // once with a reason rather than accumulating five failed attempts.
      const worker = workerWith({ ...(ENV as object), DAPTA_SYNC_URL: undefined }, (() => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch);

      await growth.enqueueEarly(principal);
      await worker.drainOnce();

      const row = (await rows('dapta_sync'))[0]!;
      expect(row.status).toBe('skipped');
      expect(row.attempts).toBe(0);
    });

    it('retries a failing destination rather than dropping the contact', async () => {
      const worker = workerWith(
        ENV,
        (() => Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch,
      );

      await growth.enqueueEarly(principal);
      await worker.drainOnce();

      const row = (await rows('dapta_sync'))[0]!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      // The status only — a marketing endpoint's error body can echo the
      // contact details, and `last_error` is a durable column.
      expect(row.lastError).toBe('dapta_sync:early → 503');
      expect(row.lastError).not.toContain('example.com');
    });

    it('SKIPS a contact with no email, recording the reason once', async () => {
      const worker = workerWith(ENV, (() => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch);

      await db.run(sql`UPDATE member SET email = NULL WHERE id = ${alex}`);
      await growth.enqueueEarly(principal);
      await worker.drainOnce();

      const row = (await rows('dapta_sync'))[0]!;
      expect(row.status).toBe('skipped');
      expect(row.attempts).toBe(0);
      expect(row.lastError).toContain('no email');
    });

    it('throws on an action no handler knows, rather than reporting success', async () => {
      // A coding fault must be loud in the delivery log, not filed away as a
      // deliberate skip. Both handlers guard, so the two cannot drift apart.
      const effects = new DaptaSyncEffects(ENV);
      effects.fetchImpl = (() => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch;

      await expect(effects.deliverContact('nonsense', '{"email":"a@b.c"}')).rejects.toThrow(
        /unknown dapta_sync action/,
      );
      await expect(effects.deliverLeadScore('nonsense', '{}')).rejects.toThrow(
        /unknown iam_onboarding action/,
      );
    });

    it('a failing contact push never re-posts the lead score', async () => {
      // The whole reason the two are separate rows: one workspace, one score.
      let scorePosts = 0;
      const worker = workerWith(ENV, ((url: string) => {
        if (url.includes('identity.example')) {
          scorePosts += 1;
          return ok();
        }
        return Promise.resolve(new Response('nope', { status: 500 }));
      }) as unknown as typeof fetch);

      await new OnboardingService(db, undefined, growth).submitQualification(principal, {
        answers: { phone: '+1 555 0100' },
      });
      await worker.drainOnce();
      await worker.drainOnce(Date.now() + 60_000);

      expect(scorePosts).toBe(1);
      expect((await rows('dapta_sync'))[0]!.attempts).toBeGreaterThanOrEqual(1);
    });
  });
});
