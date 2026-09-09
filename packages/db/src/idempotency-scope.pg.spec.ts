import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createBooking, getAvailability } from './repository';
import { createEventType } from './crud';

/**
 * #104 on real Postgres. What this adds over `idempotency-scope.spec.ts` is the
 * constraint: `booking.idempotency_key` carries a GLOBAL `UNIQUE`, and the
 * squat half of the defect is that constraint firing across tenants. Postgres
 * is the source of truth (invariant 1), so the property is proven where the
 * constraint really lives. Skipped on the SQLite default.
 *
 * This file provisions its own two tenants and never touches the demo `acme`
 * account, so it neither calls `seed()` nor needs the "seed only if acme is
 * missing" guard the other `.pg` specs carry — every row it reads it wrote.
 * The database is not recreated between runs, so each run tags its own codes.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('#104 — booking idempotency keys are account-scoped (real Postgres)', () => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const KEY = `flow-run-${tag}:create-booking`;

  interface Tenant {
    accountId: string;
    code: string;
    handle: string;
    slug: string;
    email: string;
  }

  async function tenant(name: string): Promise<Tenant> {
    const accountId = randomUUID();
    const memberId = randomUUID();
    const scheduleId = randomUUID();
    const now = Date.now();
    const code = `pg-${name}-${tag}`;
    const handle = `pg-host-${name}-${tag}`;
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${code}, ${name}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone,
            default_schedule_id, created_at)
          VALUES (${memberId}, ${accountId}, ${handle}, ${name}, ${`${handle}@example.com`},
            ${'America/New_York'}, ${scheduleId}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Working Hours'},
            ${'America/New_York'}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([1, 2, 3, 4, 5])},
            ${'09:00'}, ${'17:00'}, ${null})`,
    );
    const slug = `intro-${tag}`;
    const ev = await createEventType(db, accountId, memberId, {
      slug,
      title: 'Intro Call',
      lengthMinutes: 30,
      scheduleId,
    });
    expect(ev.ok).toBe(true);
    return { accountId, code, handle, slug, email: `booker-${name}-${tag}@example.com` };
  }

  async function firstSlotMs(t: Tenant): Promise<number> {
    const a = await getAvailability(db, {
      accountCode: t.code,
      handle: t.handle,
      slug: t.slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return new Date(a!.slots[0]!.startUtc).getTime();
  }

  function book(t: Tenant, startMs: number, idempotencyKey?: string) {
    return createBooking(db, {
      accountCode: t.code,
      handle: t.handle,
      slug: t.slug,
      startMs,
      attendee: { name: 'Pat', email: t.email, timeZone: 'America/New_York' },
      idempotencyKey,
    });
  }

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('the global UNIQUE does not let one tenant own a key for everyone', async () => {
    const a = await tenant('alpha');
    const b = await tenant('beta');
    const aStart = await firstSlotMs(a);
    const bStart = await firstSlotMs(b);

    const aFirst = await book(a, aStart, KEY);
    const bFirst = await book(b, bStart, KEY);

    // Before the fix the second insert raised 23505 on `idempotency_key` and
    // the caller saw SLOT_TAKEN — a tenant permanently locked out of a key
    // another tenant had used.
    expect(aFirst.ok).toBe(true);
    expect(bFirst.ok).toBe(true);
    if (!aFirst.ok || !bFirst.ok) return;
    expect(bFirst.booking.uid).not.toBe(aFirst.booking.uid);
    expect(bFirst.deduplicated).toBeUndefined();

    // Each side replays its own booking and only its own.
    const aReplay = await book(a, aStart, KEY);
    const bReplay = await book(b, bStart, KEY);
    expect(aReplay.ok).toBe(true);
    expect(bReplay.ok).toBe(true);
    if (!aReplay.ok || !bReplay.ok) return;
    expect(aReplay.deduplicated).toBe(true);
    expect(aReplay.booking.uid).toBe(aFirst.booking.uid);
    expect(aReplay.booking.attendee.email).toBe(a.email);
    expect(bReplay.deduplicated).toBe(true);
    expect(bReplay.booking.uid).toBe(bFirst.booking.uid);
    expect(bReplay.booking.attendee.email).toBe(b.email);
    expect(bReplay.booking.uid).not.toBe(aFirst.booking.uid);

    // The raw key is never what lands in the column, which is what makes the
    // global UNIQUE unsquattable. Scoped to the two accounts this file made,
    // because the database is shared.
    const raw = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking
          WHERE idempotency_key = ${KEY}
            AND account_id IN (${a.accountId}, ${b.accountId})`,
    );
    expect(Number(raw!.n)).toBe(0);
    const stored = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking
          WHERE idempotency_key IS NOT NULL
            AND account_id IN (${a.accountId}, ${b.accountId})`,
    );
    expect(Number(stored!.n)).toBe(2);
  });
});
