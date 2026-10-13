import { describe, expect, it } from 'vitest';
import { e2eDatabaseAllowed } from './e2e-guard';

describe('the browser suite seed writes only to a test database', () => {
  it('allows a SQLite file, a *_e2e Postgres database anywhere, and a loopback Postgres server', () => {
    for (const url of [
      'file:/tmp/e2e.db',
      'postgres://slate:slate@localhost:5432/slate_e2e',
      'postgres://slate@db.internal.example.test:5432/calendars_e2e',
      'postgresql://slate@127.0.0.1:55433/slate',
      'postgres://slate@[::1]:5432/slate',
    ]) {
      expect(e2eDatabaseAllowed(url), url).toEqual({ ok: true });
    }
  });

  it('refuses a remote database not named *_e2e, whatever NODE_ENV says', () => {
    const out = e2eDatabaseAllowed('postgres://app@db.internal.example.test:5432/calendars');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // It names the database and host, never the whole URL (which can hold a password).
      expect(out.reason).toBe('database "calendars" on db.internal.example.test is neither named *_e2e nor on loopback');
    }
    expect(e2eDatabaseAllowed('postgres://app@db.example.test/calendars_e2e_backup').ok).toBe(false);
  });

  it('refuses an empty, unparseable or foreign URL', () => {
    expect(e2eDatabaseAllowed('').ok).toBe(false);
    expect(e2eDatabaseAllowed('not a url').ok).toBe(false);
    expect(e2eDatabaseAllowed('mysql://localhost/slate_e2e').ok).toBe(false);
  });
});
