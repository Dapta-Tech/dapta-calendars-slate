import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, sql, type Db } from "./client";
import { migrate } from "./migrate";
import { seed } from "./seed";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const pgUrl = process.env.DATABASE_URL ?? "";
const isPg = /^postgres(ql)?:\/\//.test(pgUrl);

/** Each Postgres case gets its own schema; no existing tables are reset. */
async function database(
  dialect: "sqlite" | "postgres",
): Promise<{ db: Db; close: () => Promise<void> }> {
  if (dialect === "sqlite") {
    const db = await createDb("file::memory:");
    return { db, close: () => db.close() };
  }
  const admin = await createDb(pgUrl);
  const schema = `series_migration_${randomUUID().replaceAll("-", "")}`;
  // Keep the shared extension outside the disposable schema.
  await admin.execRaw(
    "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public",
  );
  await admin.execRaw(`CREATE SCHEMA "${schema}"`);
  const url = new URL(pgUrl);
  url.searchParams.set("search_path", `${schema},public`);
  const db = await createDb(url.toString());
  return {
    db,
    close: async () => {
      await db.close();
      await admin.execRaw(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.close();
    },
  };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !isPg)(
    `host event series migrations (${dialect})`,
    () => {
      const owner =
        dialect === "postgres"
          ? "0040_schedule_event_owner.sql"
          : "0039_schedule_event_owner.sql";
      const series =
        dialect === "postgres"
          ? "0041_host_event_series.sql"
          : "0040_host_event_series.sql";

      async function assertSchema(db: Db): Promise<void> {
        expect(
          await db.all(sql`SELECT event_type_id FROM schedule LIMIT 0`),
        ).toEqual([]);
        expect(
          await db.all(
            sql`SELECT id, calendar_state, materialized_until_ms FROM host_event_series LIMIT 0`,
          ),
        ).toEqual([]);
        const indexes =
          dialect === "postgres"
            ? await db.all<{ name: string }>(
                sql`SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()`,
              )
            : await db.all<{ name: string }>(
                sql`SELECT name FROM sqlite_master WHERE type = 'index'`,
              );
        expect(indexes.map((row) => row.name)).toEqual(
          expect.arrayContaining([
            "schedule_event_type_idx",
            "host_event_series_status_idx",
            "host_event_series_account_idx",
            "booking_recurring_event_idx",
          ]),
        );
      }

      it("migrates a fresh database with a free series number, then does nothing on retry", async () => {
        const { db, close } = await database(dialect);
        try {
          const applied = await migrate(db);
          expect(applied.slice(-2)).toEqual([owner, series]);
          expect(
            applied.filter((name) => name.slice(0, 4) === series.slice(0, 4)),
          ).toEqual([series]);
          await assertSchema(db);
          expect(await migrate(db)).toEqual([]);
        } finally {
          await close();
        }
      });

      it("upgrades the event editor database with only the series migration and preserves custom hours", async () => {
        const history = mkdtempSync(join(tmpdir(), "slate-series-history-"));
        const { db, close } = await database(dialect);
        try {
          mkdirSync(join(history, dialect));
          for (const file of readdirSync(join(root, dialect)).filter(
            (file) => file.endsWith(".sql") && file <= owner,
          )) {
            copyFileSync(
              join(root, dialect, file),
              join(history, dialect, file),
            );
          }
          expect((await migrate(db, history)).at(-1)).toBe(owner);
          await seed(db);
          const event = await db.get<{ id: string }>(
            sql`SELECT id FROM event_type LIMIT 1`,
          );
          await db.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at, event_type_id)
          SELECT 'series-upgrade-custom-hours', account_id, member_id, 'Custom hours', time_zone, created_at, ${event!.id}
          FROM schedule LIMIT 1`);
          const before = await db.get(
            sql`SELECT * FROM schedule WHERE id = 'series-upgrade-custom-hours'`,
          );
          expect(before).toBeDefined();

          expect(await migrate(db)).toEqual([series]);
          await assertSchema(db);
          expect(
            await db.get(
              sql`SELECT * FROM schedule WHERE id = 'series-upgrade-custom-hours'`,
            ),
          ).toEqual(before);
          expect(await migrate(db)).toEqual([]);
        } finally {
          await close();
          rmSync(history, { recursive: true, force: true });
        }
      });
    },
  );
}
