import { defineConfig } from 'vitest/config';

// The `.pg` specs (plus the Postgres block in `reminders.spec.ts`) all point at
// ONE database — whatever `DATABASE_URL` names — and `seed()` deletes and
// re-inserts the demo `acme` account wholesale. Run in parallel, one file's
// seed lands inside another file's test and takes its rows with it: the row
// comes back `undefined` and the failure names a column, not the cause. The
// per-file "seed only if the account is missing" guards do not close this,
// because on a fresh CI database every file checks before any file has seeded.
//
// So: files run sequentially whenever DATABASE_URL is Postgres, and in parallel
// on the SQLite dev default, where every spec opens its own `file::memory:` and
// shares nothing.
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? '');

export default defineConfig({
  test: { globals: true, include: ['src/**/*.spec.ts'], fileParallelism: !isPg },
});
