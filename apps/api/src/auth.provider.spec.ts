import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { loadServerEnv } from '@slate/config/env';
import { LocalAuthProvider, createAuthProvider, type ReqLike } from './auth.provider';

function reqWith(headers: Record<string, string>): ReqLike {
  return { headers };
}

describe('C1 — host auth is a real, safe-by-default port', () => {
  let db: Db;
  let seededAccountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    seededAccountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  it('LocalAuthProvider IGNORES x-slate-* impersonation headers in production', async () => {
    const provider = new LocalAuthProvider(db, { NODE_ENV: 'production' });
    const p = await provider.resolveHost(
      reqWith({ 'x-slate-account': 'FAKE-ACCT', 'x-slate-member': 'FAKE-MEMBER' }),
    );
    // Spoofed headers are dropped; only the seeded principal is resolved.
    expect(p.accountId).toBe(seededAccountId);
    expect(p.accountId).not.toBe('FAKE-ACCT');
    expect(p.memberId).not.toBe('FAKE-MEMBER');
  });

  it('LocalAuthProvider honors impersonation headers ONLY in development/test', async () => {
    const dev = new LocalAuthProvider(db, { NODE_ENV: 'development' });
    const p = await dev.resolveHost(
      reqWith({ 'x-slate-account': 'DEV-ACCT', 'x-slate-member': 'DEV-MEMBER' }),
    );
    expect(p).toEqual({ accountId: 'DEV-ACCT', memberId: 'DEV-MEMBER' });
  });

  it('createAuthProvider wires the local stub and refuses workos without the overlay', () => {
    const local = createAuthProvider(loadServerEnv({ AUTH_PROVIDER: 'local' }), db);
    expect(local.name).toBe('local');
    expect(() => createAuthProvider(loadServerEnv({ AUTH_PROVIDER: 'workos' }), db)).toThrow(/workos/i);
  });

  it('loadServerEnv fails loud on NODE_ENV=production + AUTH_PROVIDER=local', () => {
    expect(() => loadServerEnv({ NODE_ENV: 'production', AUTH_PROVIDER: 'local' })).toThrow(
      /production/i,
    );
    // A real provider in production is fine (schema-wise).
    expect(() => loadServerEnv({ NODE_ENV: 'production', AUTH_PROVIDER: 'workos' })).not.toThrow();
  });
});
