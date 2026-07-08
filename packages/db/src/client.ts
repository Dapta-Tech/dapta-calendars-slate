/**
 * createDb(DATABASE_URL) — the one factory that selects the dialect.
 *   unset / "file:…"  -> SQLite (better-sqlite3), the zero-infra default
 *   "postgres://…"    -> Postgres (postgres-js)
 *
 * Returns a small dialect-agnostic `Db` handle. Reads/writes go through
 * `all/get/run` (portable Drizzle `sql` templates). The ONE operation that
 * legitimately differs — the booking overlap-check-in-a-transaction — uses the
 * native primitives each engine exposes (`sqlite.txn` runs synchronously so the
 * check+insert is genuinely atomic; `pg.transaction` is async and backed by the
 * DB-level EXCLUDE constraint). See repository.createBooking.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { isPostgresUrl } from '@slate/config/env';

export type Dialect = 'sqlite' | 'postgres';

/** Native SQLite handles for the synchronous atomic path. */
export interface SqliteNative {
  drizzle: BetterSQLite3Database;
  /** better-sqlite3 Database — used for its synchronous `.transaction()`. */
  txn: <T>(fn: () => T) => T;
}

/** Native Postgres handle for the async atomic path. */
export interface PgNative {
  drizzle: PostgresJsDatabase;
}

export interface Db {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(query: SQL): Promise<T[]>;
  get<T = Record<string, unknown>>(query: SQL): Promise<T | undefined>;
  run(query: SQL): Promise<void>;
  /** Execute a raw multi-statement SQL script (migrations only; no params). */
  execRaw(sqlText: string): Promise<void>;
  /** Present only when dialect === 'sqlite'. */
  sqlite?: SqliteNative;
  /** Present only when dialect === 'postgres'. */
  pg?: PgNative;
  close(): Promise<void>;
}

export { sql };

/** Strip a leading "file:" and resolve the SQLite path (":memory:" passes through). */
export function sqlitePathFromUrl(url: string): string {
  if (!url || url === 'file::memory:' || url === ':memory:') return ':memory:';
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export async function createDb(
  databaseUrl = process.env.DATABASE_URL ?? 'file:./.data/dev.db',
): Promise<Db> {
  if (isPostgresUrl(databaseUrl)) {
    return createPostgresDb(databaseUrl);
  }
  return createSqliteDb(databaseUrl);
}

// --- SQLite ---------------------------------------------------------------

async function createSqliteDb(url: string): Promise<Db> {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const path = sqlitePathFromUrl(url);
  if (path !== ':memory:') {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);

  return {
    dialect: 'sqlite',
    all: <T>(query: SQL) => Promise.resolve(db.all(query) as T[]),
    get: <T>(query: SQL) => Promise.resolve(db.get(query) as T | undefined),
    run: (query: SQL) => {
      db.run(query);
      return Promise.resolve();
    },
    execRaw: (sqlText: string) => {
      sqlite.exec(sqlText);
      return Promise.resolve();
    },
    sqlite: {
      drizzle: db,
      txn: <T>(fn: () => T): T => sqlite.transaction(fn)(),
    },
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

// --- Postgres -------------------------------------------------------------

async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const client = postgres(url, { max: 10 });
  const db = drizzle(client);

  return {
    dialect: 'postgres',
    all: async <T>(query: SQL) => (await db.execute(query)) as unknown as T[],
    get: async <T>(query: SQL) => {
      const rows = (await db.execute(query)) as unknown as T[];
      return rows[0];
    },
    run: async (query: SQL) => {
      await db.execute(query);
    },
    execRaw: async (sqlText: string) => {
      await client.unsafe(sqlText);
    },
    pg: { drizzle: db },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
