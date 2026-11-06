import { describe } from 'vitest';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { customHoursSuite } from './event-custom-hours.fixture';

// Runs against a REAL Postgres only when DATABASE_URL is one (the CI parity
// job); skipped on the SQLite path.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');

if (isPg) {
  let shared: Db | null = null;
  customHoursSuite('postgres', async () => {
    if (!shared) {
      shared = await createDb(url);
      await migrate(shared);
    }
    return shared;
  });
} else {
  describe.skip('event custom hours (postgres)', () => {});
}
