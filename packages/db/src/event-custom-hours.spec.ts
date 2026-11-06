import { createDb } from './client';
import { migrate } from './migrate';
import { customHoursSuite } from './event-custom-hours.fixture';

customHoursSuite('sqlite', async () => {
  const db = await createDb('file::memory:');
  await migrate(db);
  return db;
});
