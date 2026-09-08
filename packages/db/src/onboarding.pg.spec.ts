import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import {
  claimQualification,
  countPublishedEventTypes,
  getAccountOnboarding,
  getOnboardingGates,
  personQualifiedElsewhere,
} from './onboarding';

/**
 * The onboarding data layer against a REAL Postgres. Its SQLite twin
 * (onboarding.spec.ts) owns the RULES; this file exists for the places the two
 * dialects genuinely differ and where SQLite would hide a break:
 *
 *  - `onboarding` is `jsonb` here and `text` there, so writes go through
 *    `jsonParam`'s `::jsonb` cast and reads come back parsed, not as a string;
 *  - `personQualifiedElsewhere` builds its identity predicate rather than
 *    binding nullable parameters into `IS NOT NULL`, because Postgres rejects a
 *    parameter whose type it cannot infer (42P18) — SQLite never reproduces it;
 *  - the migration's stamp uses `(EXTRACT(EPOCH FROM now()) * 1000)::BIGINT`,
 *    which has no SQLite counterpart.
 *
 * EVERY fixture here is created by this file and unique per run. It deliberately
 * does NOT call `seed()` or read the seeded `acme` account: a Postgres
 * DATABASE_URL is a persistent, SHARED database, `repository.pg.spec.ts` seeds
 * it concurrently, and `seed()` deletes `acme` before re-inserting it — so any
 * assertion resting on seeded rows races that delete. Skipped on the SQLite dev
 * default, like repository.pg.spec.ts.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('onboarding gates (real Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('stamps an unstamped account with the migration’s own pg expression', async () => {
    const { accountId } = await freshWorkspace({});
    await db.run(sql`UPDATE account SET onboarding_completed_at = NULL WHERE id = ${accountId}`);
    // Verbatim from migration 0013 — this is the cast under test.
    await db.run(
      sql`UPDATE account
             SET onboarding_completed_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
           WHERE onboarding_completed_at IS NULL`,
    );
    const state = await getAccountOnboarding(db, accountId);
    expect(state.completedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it('round-trips the answers through jsonb', async () => {
    const { accountId } = await freshWorkspace({ unstamped: true });
    const r = await claimQualification(db, accountId, { industry: 'saas', use_case: 'demos' }, 1_000);
    expect(r.claimed).toBe(true);
    // An OBJECT on jsonb, not the JSON string SQLite hands back.
    expect((await getAccountOnboarding(db, accountId)).onboarding).toEqual({
      industry: 'saas',
      use_case: 'demos',
    });
  });

  it('holds the write-once guard under Postgres', async () => {
    const { accountId } = await freshWorkspace({ unstamped: true });
    await claimQualification(db, accountId, { industry: 'saas' }, 1_000);
    const second = await claimQualification(db, accountId, { industry: 'retail' }, 2_000);
    expect(second.claimed).toBe(false);
    expect((await getAccountOnboarding(db, accountId)).onboarding).toEqual({ industry: 'saas' });
  });

  // The 42P18 case. Both branches run: one identity present, and neither —
  // the NULL branch is where an untyped bound parameter used to blow up.
  it('runs the cross-account person check without a parameter-type error', async () => {
    const solo = await freshWorkspace({ email: `solo-${randomUUID()}@example.com` });
    await expect(personQualifiedElsewhere(db, solo.accountId, solo.memberId)).resolves.toBe(false);

    const ghost = await freshWorkspace({});
    await expect(personQualifiedElsewhere(db, ghost.accountId, ghost.memberId)).resolves.toBe(false);
  });

  it('finds the same human qualified in another workspace', async () => {
    const email = `twin-${randomUUID()}@example.com`;
    const home = await freshWorkspace({ email });
    expect(await personQualifiedElsewhere(db, home.accountId, home.memberId)).toBe(false);

    await freshWorkspace({ email, qualified: true });
    expect(await personQualifiedElsewhere(db, home.accountId, home.memberId)).toBe(true);
  });

  it('matches on upstream identity as well as email', async () => {
    const externalId = `iam-${randomUUID()}`;
    const home = await freshWorkspace({ externalId });
    expect(await personQualifiedElsewhere(db, home.accountId, home.memberId)).toBe(false);

    await freshWorkspace({ externalId, qualified: true });
    expect(await personQualifiedElsewhere(db, home.accountId, home.memberId)).toBe(true);
  });

  it('counts only the host’s own PUBLISHED, PERSONAL event types', async () => {
    const { accountId, memberId } = await freshWorkspace({});
    expect(await countPublishedEventTypes(db, memberId)).toBe(0);

    await addEventType(accountId, { memberId });
    expect(await countPublishedEventTypes(db, memberId)).toBe(1);

    // A hidden one does not make the public page render anything.
    await addEventType(accountId, { memberId, hidden: true });
    expect(await countPublishedEventTypes(db, memberId)).toBe(1);

    // Neither does a team event this member merely hosts — the #84 case.
    await addEventType(accountId, { teamId: randomUUID() });
    expect(await countPublishedEventTypes(db, memberId)).toBe(1);
  });

  it('composes the two verdicts the same way as the SQLite path', async () => {
    const owner = await freshWorkspace({ unstamped: true, role: 'owner' });
    expect(await getOnboardingGates(db, owner.accountId, owner.memberId)).toMatchObject({
      onboardingRequired: true,
      setupRequired: true,
    });

    // A plain member of the SAME unqualified account owes setup only — the
    // invited-host dead end ADR 0002 exists to prevent.
    const plain = await addMember(owner.accountId, { role: 'member' });
    expect(await getOnboardingGates(db, owner.accountId, plain)).toMatchObject({
      onboardingRequired: false,
      setupRequired: true,
    });

    await claimQualification(db, owner.accountId, { industry: 'saas' });
    await addEventType(owner.accountId, { memberId: owner.memberId });
    expect(await getOnboardingGates(db, owner.accountId, owner.memberId)).toMatchObject({
      onboardingRequired: false,
      setupRequired: false,
    });
  });

  // --- Fixtures (all run-unique; nothing here reads seeded data) -----------

  async function freshWorkspace(args: {
    email?: string;
    externalId?: string;
    qualified?: boolean;
    unstamped?: boolean;
    role?: string;
  }): Promise<{ accountId: string; memberId: string }> {
    const accountId = randomUUID();
    // Stamped by default so a fixture only owes gate 1 when a test says so.
    const stamp = args.unstamped ? null : (args.qualified ? 5_000 : Date.now());
    await db.run(
      sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at)
          VALUES (${accountId}, ${'pg' + accountId.slice(0, 8)}, ${'Fresh Co'},
                  ${stamp}, ${Date.now()})`,
    );
    const memberId = await addMember(accountId, {
      email: args.email,
      externalId: args.externalId,
      role: args.role,
    });
    return { accountId, memberId };
  }

  async function addMember(
    accountId: string,
    args: { email?: string; externalId?: string; role?: string },
  ): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, external_id, email, role, status, time_zone, created_at)
          VALUES (${id}, ${accountId}, ${'h' + id.slice(0, 8)}, ${args.externalId ?? null},
                  ${args.email ?? null}, ${args.role ?? 'owner'}, ${'active'}, ${'UTC'}, ${Date.now()})`,
    );
    return id;
  }

  async function addEventType(
    accountId: string,
    args: { memberId?: string; teamId?: string; hidden?: boolean },
  ): Promise<void> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO event_type (id, account_id, member_id, team_id, slug, title, length_minutes,
            hidden, created_at)
          VALUES (${id}, ${accountId}, ${args.memberId ?? null}, ${args.teamId ?? null},
                  ${'s' + id.slice(0, 8)}, ${'Fixture'}, ${30}, ${args.hidden ? 1 : 0}, ${Date.now()})`,
    );
  }
});
