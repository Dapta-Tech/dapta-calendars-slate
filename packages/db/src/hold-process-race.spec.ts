import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAvailability } from './repository';
import { insertHoldGuarded } from './parity';
import { createEventType } from './crud';
import { memberWithHours } from './member-hours.fixture';

/**
 * Two API processes on one SQLite file, holding the same time. The guarded
 * hold write takes the write lock at BEGIN (IMMEDIATE), so the second process
 * waits for the first to commit, reads its hold, and answers INVALID_SLOT. A
 * deferred transaction read a stale snapshot first and then failed its lock
 * upgrade with SQLITE_BUSY, a 500 instead of a refusal.
 *
 * The "other process" is a real child process holding the lock while it
 * inserts a hold on the same time, then committing.
 */
const require = createRequire(import.meta.url);
const sqliteModule = require.resolve('better-sqlite3');

describe('a hold across two processes on one SQLite file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slate-hold-'));
  const file = join(dir, 'race.db');
  let db: Db;
  let accountId: string;
  let memberId: string;
  let eventTypeId: string;
  const handle = 'process-race-host';
  const slug = 'process-race-event';

  beforeAll(async () => {
    db = await createDb(`file:${file}`);
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const host = await memberWithHours(db, {
      accountId,
      handle,
      name: 'Race Host',
      email: `${handle}@example.com`,
      timeZone: 'UTC',
      scheduleName: 'Always',
      days: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00',
      endTime: '23:59',
    });
    memberId = host.id;
    const scheduleId = host.scheduleId;
    const ev = await createEventType(db, accountId, memberId, { slug, title: 'Race', lengthMinutes: 30, scheduleId });
    if (!ev.ok) throw new Error(`setup: event create failed (${ev.reason})`);
    eventTypeId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = ${slug}`))!.id;
  });

  afterAll(async () => {
    await db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A second process: take the write lock, insert a hold on `startMs`, wait, commit. */
  function otherProcessHolds(startMs: number): { locked: Promise<void>; done: Promise<number | null> } {
    const row = {
      id: randomUUID(),
      account_id: accountId,
      event_type_id: eventTypeId,
      member_id: memberId,
      slot_start_ms: startMs,
      slot_end_ms: startMs + 30 * 60_000,
      uid: randomUUID(),
      release_at_ms: Date.now() + 10 * 60_000,
      created_at: Date.now(),
    };
    const program = `
      const Database = require(${JSON.stringify(sqliteModule)});
      const db = new Database(${JSON.stringify(file)});
      db.pragma('journal_mode = WAL');
      const r = ${JSON.stringify(row)};
      db.prepare('BEGIN IMMEDIATE').run();
      db.prepare('INSERT INTO slot_reservation (id, account_id, event_type_id, member_id, slot_start_ms, slot_end_ms, uid, release_at_ms, is_seat, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)')
        .run(r.id, r.account_id, r.event_type_id, r.member_id, r.slot_start_ms, r.slot_end_ms, r.uid, r.release_at_ms, r.created_at);
      process.stdout.write('locked\\n');
      setTimeout(() => { db.prepare('COMMIT').run(); db.close(); process.exit(0); }, 300);
    `;
    const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'inherit'] });
    const locked = new Promise<void>((resolve) =>
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('locked') && resolve()),
    );
    const done = new Promise<number | null>((resolve) => child.on('exit', resolve));
    return { locked, done };
  }

  it('the second process waits for the lock and answers INVALID_SLOT, never SQLITE_BUSY', async () => {
    const fromMs = Date.now() + 2 * 86_400_000;
    const a = await getAvailability(db, { accountCode: 'acme', handle, slug, fromMs, toMs: fromMs + 86_400_000 });
    const start = new Date(a!.slots[0]!.startUtc).getTime();

    // The other process holds the write lock with its hold inserted. This
    // process's guarded write starts now: deferred, it would read a snapshot
    // without that hold and then fail to upgrade with SQLITE_BUSY.
    const other = otherProcessHolds(start);
    await other.locked;
    const out = await insertHoldGuarded(db, {
      accountId,
      eventTypeId,
      memberId,
      startMs: start,
      endMs: start + 30 * 60_000,
      uid: randomUUID(),
      releaseAtMs: Date.now() + 10 * 60_000,
      now: Date.now(),
    });
    expect(await other.done).toBe(0);
    expect(out).toBe('INVALID_SLOT');
    const holds = await db.get<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE member_id = ${memberId} AND slot_start_ms = ${start}`,
    );
    expect(Number(holds?.n)).toBe(1);
  });
});
