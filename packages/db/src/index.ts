/**
 * @slate/db — the portable data layer. createDb() selects SQLite (dev) or
 * Postgres (prod); the repository turns the schema into booking operations;
 * migrate()/seed() bootstrap a clone-and-run database.
 */
export * from './client';
export * from './repository';
export { migrate } from './migrate';
export { seed, type SeedResult } from './seed';
export { sqliteSchema } from './schema.sqlite';
export { pgSchema } from './schema.pg';
