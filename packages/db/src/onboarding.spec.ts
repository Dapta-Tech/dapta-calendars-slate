import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import {
  claimQualification,
  countPublishedEventTypes,
  getAccountOnboarding,
  getOnboardingGates,
  personQualifiedElsewhere,
} from './onboarding';

describe('onboarding gates (ADR 0002)', () => {
  let db: Db;
  let accountId: string;
  let alex: string; // seeded owner, HAS a personal event type
  let jordan: string; // seeded member, has ONLY a team event

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
  });

  // --- The stamp ----------------------------------------------------------

  describe('the onboarding stamp', () => {
    // The seed DELETEs and re-INSERTs the demo account, and it runs after
    // migrate() — so the migration's stamp alone is not enough here. Both
    // paths have to stamp or a bare clone opens into the wizard.
    it('stamps the seeded demo account so `pnpm dev` never lands in the wizard', async () => {
      const state = await getAccountOnboarding(db, accountId);
      expect(state.completedAt).not.toBeNull();
    });

    it('stamps a pre-existing account the migration finds unstamped', async () => {
      // A row that predates the migration: insert it, blank the claim, re-run.
      const legacy = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${legacy}, ${'lg' + legacy.slice(0, 4)}, ${'Legacy Co'}, ${Date.now()})`,
      );
      await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${legacy}`);
      await db.run(
        sql`UPDATE account SET onboarding_completed_at = ${Date.now()}
             WHERE onboarding_completed_at IS NULL`,
      );
      expect((await getAccountOnboarding(db, legacy)).completedAt).not.toBeNull();
    });

    it('leaves a NEWLY created account unstamped — it genuinely owes onboarding', async () => {
      const fresh = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${fresh}, ${'nw' + fresh.slice(0, 4)}, ${'New Co'}, ${Date.now()})`,
      );
      const state = await getAccountOnboarding(db, fresh);
      expect(state.completedAt).toBeNull();
    });
  });

  // --- Gate 2's counter ---------------------------------------------------

  describe('countPublishedEventTypes', () => {
    it('counts the host’s own published event type', async () => {
      expect(await countPublishedEventTypes(db, alex)).toBe(1);
    });

    // The exact bug #84 exists to kill: Jordan has a handle and an auto-created
    // public page, is a host on the round-robin team event, and yet
    // /acme/jordan-lee renders EMPTY. A team event is not a personal one.
    it('does NOT count a team event the member merely hosts', async () => {
      expect(await countPublishedEventTypes(db, jordan)).toBe(0);
    });

    it('does not count a hidden event type — an unpublished page is still empty', async () => {
      await db.run(sql`UPDATE event_type SET hidden = 1 WHERE member_id = ${alex}`);
      expect(await countPublishedEventTypes(db, alex)).toBe(0);
    });

    it('never counts another member’s event types', async () => {
      await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);
      expect(await countPublishedEventTypes(db, alex)).toBe(0);
      expect(await countPublishedEventTypes(db, jordan)).toBe(0);
    });
  });

  // --- Gate 1's write-once claim -----------------------------------------

  describe('claimQualification', () => {
    let fresh: string;
    beforeEach(async () => {
      fresh = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${fresh}, ${'nw' + fresh.slice(0, 4)}, ${'New Co'}, ${Date.now()})`,
      );
    });

    it('claims an unclaimed account and stores the answers', async () => {
      const r = await claimQualification(db, fresh, { industry: 'saas', phone: '+1 555' }, 1_000);
      expect(r.claimed).toBe(true);
      expect(r.completedAt).toBe(1_000);
      const state = await getAccountOnboarding(db, fresh);
      expect(state.onboarding).toEqual({ industry: 'saas', phone: '+1 555' });
      expect(state.completedAt).toBe(1_000);
    });

    // Write-once is the whole point: a second claim must not overwrite the
    // first, or a later member could silently rewrite the workspace's answers.
    it('REFUSES a second claim and preserves the first answers', async () => {
      await claimQualification(db, fresh, { industry: 'saas' }, 1_000);
      const second = await claimQualification(db, fresh, { industry: 'retail' }, 2_000);
      expect(second.claimed).toBe(false);
      expect(second.completedAt).toBe(1_000);
      const state = await getAccountOnboarding(db, fresh);
      expect(state.onboarding).toEqual({ industry: 'saas' });
    });

    // Regression: the outcome used to be inferred by comparing the stored
    // timestamp with the one this call passed, so two submissions inside the
    // SAME millisecond both reported `claimed: true` — the loser recognised
    // its own `now` in the row. The stored answers were always correct; the
    // reported outcome was not.
    it('reports exactly one winner when both claims share a timestamp', async () => {
      const first = await claimQualification(db, fresh, { industry: 'saas' }, 1_000);
      const second = await claimQualification(db, fresh, { industry: 'retail' }, 1_000);
      expect([first.claimed, second.claimed]).toEqual([true, false]);
      expect((await getAccountOnboarding(db, fresh)).onboarding).toEqual({ industry: 'saas' });
    });

    it('reports one winner with the real clock, back to back', async () => {
      const first = await claimQualification(db, fresh, { industry: 'saas' });
      const second = await claimQualification(db, fresh, { industry: 'retail' });
      expect([first.claimed, second.claimed]).toEqual([true, false]);
    });

    it('is a no-op against an account already stamped', async () => {
      const r = await claimQualification(db, accountId, { industry: 'saas' }, 9_999);
      expect(r.claimed).toBe(false);
      expect((await getAccountOnboarding(db, accountId)).onboarding).toBeNull();
    });
  });

  // --- The person-level check --------------------------------------------

  describe('personQualifiedElsewhere', () => {
    it('is false for a person who belongs to one workspace only', async () => {
      expect(await personQualifiedElsewhere(db, accountId, alex)).toBe(false);
    });

    it('is TRUE when the same human already qualified in another workspace', async () => {
      // A second workspace, already qualified, holding the same human by email.
      const other = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at)
            VALUES (${other}, ${'ot' + other.slice(0, 4)}, ${'Other Co'}, ${5_000}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
            VALUES (${randomUUID()}, ${other}, ${'alex'}, ${'Alex Rivera'}, ${'alex@example.com'},
                    ${'UTC'}, ${Date.now()})`,
      );
      expect(await personQualifiedElsewhere(db, accountId, alex)).toBe(true);
    });

    it('matches on upstream identity too, not only email', async () => {
      await db.run(sql`UPDATE member SET external_id = ${'iam-user-1'} WHERE id = ${alex}`);
      const other = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at)
            VALUES (${other}, ${'ot' + other.slice(0, 4)}, ${'Other Co'}, ${5_000}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, external_id, email, time_zone, created_at)
            VALUES (${randomUUID()}, ${other}, ${'a'}, ${'iam-user-1'}, ${'different@example.com'},
                    ${'UTC'}, ${Date.now()})`,
      );
      expect(await personQualifiedElsewhere(db, accountId, alex)).toBe(true);
    });

    it('ignores another workspace that has NOT qualified', async () => {
      const other = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${other}, ${'ot' + other.slice(0, 4)}, ${'Other Co'}, ${Date.now()})`,
      );
      await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${other}`);
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, email, time_zone, created_at)
            VALUES (${randomUUID()}, ${other}, ${'alex'}, ${'alex@example.com'}, ${'UTC'}, ${Date.now()})`,
      );
      expect(await personQualifiedElsewhere(db, accountId, alex)).toBe(false);
    });

    // A member with neither identity nor email must not match every other
    // member with neither — that would silently exempt the whole cohort.
    it('never matches on two NULL identities', async () => {
      const other = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at)
            VALUES (${other}, ${'ot' + other.slice(0, 4)}, ${'Other Co'}, ${5_000}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, time_zone, created_at)
            VALUES (${randomUUID()}, ${other}, ${'ghost'}, ${'UTC'}, ${Date.now()})`,
      );
      await db.run(sql`UPDATE member SET email = NULL, external_id = NULL WHERE id = ${alex}`);
      expect(await personQualifiedElsewhere(db, accountId, alex)).toBe(false);
    });
  });

  // --- The composed verdict ----------------------------------------------

  describe('getOnboardingGates', () => {
    it('owes NOTHING to the seeded owner — stamped account, one event type', async () => {
      expect(await getOnboardingGates(db, accountId, alex)).toMatchObject({
        onboardingRequired: false,
        setupRequired: false,
      });
    });

    // Jordan is the live bug: bookable-looking, publicly empty.
    it('owes SETUP to the seeded member who has no event type of their own', async () => {
      expect(await getOnboardingGates(db, accountId, jordan)).toMatchObject({
        onboardingRequired: false,
        setupRequired: true,
      });
    });

    it('owes BOTH gates to the owner of a brand-new account', async () => {
      await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
      await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);
      expect(await getOnboardingGates(db, accountId, alex)).toMatchObject({
        onboardingRequired: true,
        setupRequired: true,
      });
    });

    // The invited-host dead end ADR 0002 exists to prevent: a plain member of an
    // unqualified account owes setup only, never the commercial questions.
    it('owes SETUP ONLY to a plain member, even on an unqualified account', async () => {
      await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
      expect(await getOnboardingGates(db, accountId, jordan)).toMatchObject({
        onboardingRequired: false,
        setupRequired: true,
      });
    });

    it('re-owes setup after the host deletes their last event type', async () => {
      expect((await getOnboardingGates(db, accountId, alex)).setupRequired).toBe(false);
      await db.run(sql`DELETE FROM event_type WHERE member_id = ${alex}`);
      expect((await getOnboardingGates(db, accountId, alex)).setupRequired).toBe(true);
    });

    it('owes nothing to a disabled member', async () => {
      await db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${jordan}`);
      expect(await getOnboardingGates(db, accountId, jordan)).toMatchObject({
        onboardingRequired: false,
        setupRequired: false,
      });
    });

    it('returns both gates closed for an unknown member rather than throwing', async () => {
      expect(await getOnboardingGates(db, accountId, randomUUID())).toMatchObject({
        onboardingRequired: false,
        setupRequired: false,
      });
    });
  });
});
