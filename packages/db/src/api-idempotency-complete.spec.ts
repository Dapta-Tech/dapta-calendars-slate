import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { claimApiIdempotency, completeApiIdempotency } from './v2-pilot';

/**
 * The conditional stores of an idempotency record: `onlyOpen` writes only on a
 * record without a result; `replaceRefusal` also replaces a stored refusal
 * (status 400 and up) but never a stored success. Atomic: the condition is part
 * of the UPDATE. Runs on SQLite, and on Postgres too when DATABASE_URL names one.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const engines: Array<[string, string]> = [['SQLite', 'file::memory:'], ...(isPg ? [['Postgres', url] as [string, string]] : [])];

describe.each(engines)('completeApiIdempotency conditions (%s)', (_engine, dbUrl) => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb(dbUrl);
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const open = () =>
    claimApiIdempotency(db, {
      namespaceHash: `spec-${randomUUID()}`,
      accountId: randomUUID(),
      apiKeyId: 'spec',
      method: 'MCP',
      path: 'spec',
      requestHash: 'h',
    });
  const statusOf = async (id: string) =>
    (await db.get<{ status_code: number | string | null }>(sql`SELECT status_code FROM api_idempotency WHERE id = ${id}`))!.status_code;

  it('onlyOpen writes once and never over a stored result', async () => {
    const c = await open();
    expect(await completeApiIdempotency(db, c.id, 409, { error: 'SLOT_TAKEN' }, { onlyOpen: true })).toBe(true);
    expect(await completeApiIdempotency(db, c.id, 201, { ok: true }, { onlyOpen: true })).toBe(false);
    expect(Number(await statusOf(c.id))).toBe(409);
  });

  it('replaceRefusal replaces an open record or a refusal, never a success', async () => {
    const c = await open();
    expect(await completeApiIdempotency(db, c.id, 409, { error: 'SLOT_TAKEN' }, { onlyOpen: true })).toBe(true);
    expect(await completeApiIdempotency(db, c.id, 201, { uid: 'a' }, { replaceRefusal: true })).toBe(true);
    expect(await completeApiIdempotency(db, c.id, 201, { uid: 'b' }, { replaceRefusal: true })).toBe(false);
    expect(Number(await statusOf(c.id))).toBe(201);
    const fresh = await open();
    expect(await completeApiIdempotency(db, fresh.id, 201, { uid: 'c' }, { replaceRefusal: true })).toBe(true);
  });

  it('a record that is gone writes nothing and says so', async () => {
    expect(await completeApiIdempotency(db, randomUUID(), 201, { uid: 'x' }, { replaceRefusal: true })).toBe(false);
  });
});
