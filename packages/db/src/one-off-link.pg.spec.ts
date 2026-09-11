import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { cancelBooking } from './parity';
import { createEventType } from './crud';
import {
  consumeOneOffLink,
  getOneOffLinkByToken,
  listOneOffLinks,
  mintOneOffLink,
  resolveOneOffLink,
  revokeOneOffLink,
} from './one-off-link';

/**
 * One-off links (#69 / AB2, #110) on real Postgres — the source of truth
 * (invariant 1).
 *
 * What this adds over `one-off-link.spec.ts` is DIALECT coverage, and there are
 * two things in this feature that genuinely differ between engines:
 *
 *  1. `consumeOneOffLink` and `revokeOneOffLink` are conditional writes that
 *     read their own outcome through `UPDATE … RETURNING`. Postgres has always
 *     had it; SQLite only since 3.35. A single statement is what makes "at most
 *     one consumer" true without a transaction, so if the pattern behaved
 *     differently here the guarantee would be silently weaker in production
 *     than in dev.
 *
 *  2. `created_at` / `consumed_at` / `revoked_at` are `BIGINT` on Postgres and
 *     `INTEGER` on SQLite, and the Postgres driver hands `bigint` back as a
 *     STRING. `oneOffLinkState` keys on truthiness and the view coerces with
 *     `Number()`, so a regression there would make every consumed link read as
 *     live on Postgres alone — which is the exact shape of bug this file exists
 *     to catch.
 *
 * Skipped on the SQLite default, like every other `.pg.spec.ts` here.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('one-off links (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  // Unique per run: this database is not recreated between runs, so fixed slugs
  // would collide with rows a previous run left behind.
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed ONLY if the demo account is missing — `seed()` deletes and
    // re-inserts it wholesale and several spec files share one Postgres. Same
    // guard `duplicate-guard.pg.spec.ts` documents.
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  const attendee = { name: 'Pat', email: `pat-${tag}@example.com`, timeZone: 'America/New_York' };

  async function hiddenEvent(slug: string) {
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      hidden: true,
    });
    if (!ev.ok) throw new Error('event create failed');
    return ev.value.id;
  }

  async function slotsFor(slug: string): Promise<number[]> {
    const r = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
      includeHidden: true,
    });
    return (r?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  it('round-trips the timestamps — a consumed link does not read as live', async () => {
    // `bigint` comes back from the Postgres driver as a string. This is the
    // assertion that catches a regression which would only ever show up here.
    const slug = `pg-oneoff-ts-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId, createdByMemberId: alexId }))!;
    expect(link.state).toBe('live');
    expect(link.createdAt).toBeTypeOf('number');
    expect(Number.isFinite(link.createdAt)).toBe(true);

    await consumeOneOffLink(db, link.id, randomUUID());
    const after = (await getOneOffLinkByToken(db, link.token))!;
    expect(after.state).toBe('consumed');
    expect(after.consumedAt).toBeTypeOf('number');
    expect(Number.isFinite(after.consumedAt!)).toBe(true);
  });

  it('records at most one consumer — the conditional UPDATE … RETURNING holds', async () => {
    const slug = `pg-oneoff-race-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId }))!;
    const first = randomUUID();

    // Issued CONCURRENTLY, which is the shape the guarantee is about: two
    // submissions landing at once must not both record themselves.
    const [a, b] = await Promise.all([
      consumeOneOffLink(db, link.id, first),
      consumeOneOffLink(db, link.id, randomUUID()),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await db.get<{ consumed_booking_id: string }>(
      sql`SELECT consumed_booking_id FROM one_off_link WHERE id = ${link.id}`,
    );
    expect(row?.consumed_booking_id).toBeTruthy();
  });

  it('revokes conditionally, and a second revoke reports nothing left to do', async () => {
    const slug = `pg-oneoff-revoke-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId }))!;
    expect(await revokeOneOffLink(db, accountId, eventTypeId, link.id)).toBe(true);
    expect(await revokeOneOffLink(db, accountId, eventTypeId, link.id)).toBe(false);
    // The event type is part of the predicate, so naming another one revokes
    // nothing even inside the same account.
    const other = await hiddenEvent(`${slug}-other`);
    const live = (await mintOneOffLink(db, { accountId, eventTypeId }))!;
    expect(await revokeOneOffLink(db, accountId, other, live.id)).toBe(false);
    expect((await getOneOffLinkByToken(db, live.token))?.state).toBe('live');
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('revoked');
  });

  it('refuses a duplicate token — the UNIQUE index is really there', async () => {
    // The index is declared in the migration, never in the drizzle schema, so
    // this is the only place its existence on Postgres is proven.
    const slug = `pg-oneoff-uq-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId }))!;
    await expect(
      db.run(
        sql`INSERT INTO one_off_link (id, account_id, event_type_id, token, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${eventTypeId}, ${link.token}, ${Date.now()})`,
      ),
    ).rejects.toThrow();
  });

  it('books a hidden event through the link, and a cancel never revives it', async () => {
    const slug = `pg-oneoff-book-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId, createdByMemberId: alexId }))!;
    const slots = await slotsFor(slug);

    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs: slots[0]!,
      attendee,
      oneOffToken: link.token,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');

    // Re-use is refused, on the dialect that is the source of truth.
    expect(
      await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug,
        startMs: slots[1]!,
        attendee,
        oneOffToken: link.token,
      }),
    ).toMatchObject({ ok: false, reason: 'ONE_OFF_GONE' });

    // The rule a refactor will get wrong, asserted on Postgres too.
    await cancelBooking(db, { uid: booked.booking.uid, byHost: true, accountId });
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');
    expect(await resolveOneOffLink(db, link.token)).toEqual({ state: 'consumed' });
  });

  it('lists account-scoped, newest first, naming the consuming booking', async () => {
    const slug = `pg-oneoff-list-${tag}`;
    const eventTypeId = await hiddenEvent(slug);
    const link = (await mintOneOffLink(db, { accountId, eventTypeId }))!;
    const slots = await slotsFor(slug);
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs: slots[0]!,
      attendee: { ...attendee, email: `list-${tag}@example.com` },
      oneOffToken: link.token,
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const listed = await listOneOffLinks(db, accountId, eventTypeId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.consumedBookingUid).toBe(booked.booking.uid);
    // Invariant 4: another account's id sees nothing, even holding the event id.
    expect(await listOneOffLinks(db, randomUUID(), eventTypeId)).toEqual([]);
  });
});
