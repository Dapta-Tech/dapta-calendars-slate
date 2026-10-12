/**
 * Test-only seed for the browser suite (apps/web/e2e). Runs AFTER `db:seed` and
 * connects each seeded host to the stand-in calendar backend
 * (scripts/qa/stand-in-calendar.mjs): one connected calendar per host, the
 * destination of its bookings and checked for conflicts, so the suite sees the
 * real busy read and the real event writes.
 *
 *   DATABASE_URL=... pnpm --filter @slate/api exec tsx src/cli/e2e-seed.ts
 *
 * Idempotent: a host that already has a connection is left alone. Refuses to
 * run under NODE_ENV=production.
 */
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@slate/db';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('[e2e-seed] refusing to run under NODE_ENV=production.');
    process.exit(1);
  }
  const db = await createDb(process.env.DATABASE_URL ?? '');
  const hosts = await db.all<{ id: string; account_id: string; email: string; handle: string }>(
    sql`SELECT m.id, m.account_id, m.email, m.handle FROM member m JOIN account a ON a.id = m.account_id
        WHERE a.code = 'acme' AND m.handle IN ('alex-rivera', 'jordan-lee')`,
  );
  for (const h of hosts) {
    const has = await db.get(sql`SELECT id FROM connected_calendar WHERE member_id = ${h.id} LIMIT 1`);
    if (has) continue;
    await db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, primary_email,
            is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${h.account_id}, ${h.id}, ${'generic'}, ${`e2e-${h.handle}`}, ${h.email},
            1, 1, ${Date.now()})`,
    );
  }
  console.log(`[e2e-seed] ${hosts.length} host(s) connected to the stand-in calendar`);
  await db.close();
}

main().catch((err) => {
  console.error('[e2e-seed] failed:', err);
  process.exit(1);
});
