#!/usr/bin/env node
// Boot one API process for the browser suite, the way production does
// (apps/api/src/main.ts), and tee its stdout to e2e/.results-logs/<name>.log so
// the log assertions read exactly what an operator would.
//
//   node e2e/start-api.mjs main      the suite's API (rate limiting relaxed)
//   node e2e/start-api.mjs limited   a second API on the same database, small limit
//
// `main` prepares the database first: migrate, seed, then connect the seeded
// hosts to the stand-in calendar. A fresh SQLite file per run unless
// E2E_DATABASE_URL names a database (a Postgres one is reset by the seed).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const api = resolve(root, 'apps/api');
const which = process.argv[2] ?? 'main';
const env = (k, d) => process.env[k] ?? d;
const webPort = env('E2E_WEB_PORT', '3411');
const port = which === 'limited' ? env('E2E_LIMITED_API_PORT', '4412') : env('E2E_API_PORT', '4411');
const sqliteFile = resolve(root, '.data/e2e.db');
const DATABASE_URL = env('E2E_DATABASE_URL', `file:${sqliteFile}`);

const childEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL,
  API_PORT: port,
  PUBLIC_APP_URL: `http://localhost:${webPort}`,
  CALENDAR_PROVIDER: 'external',
  CALENDAR_API_BASE_URL: `http://127.0.0.1:${env('E2E_CALENDAR_PORT', '4519')}`,
  CALENDAR_API_TOKEN: 'e2e-token',
  EMAIL_PROVIDER: 'log-only',
  REQUEST_LOG_ENABLED: 'true',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_TRUSTED_PROXY_HOPS: '1',
  ...(which === 'limited'
    ? { RATE_LIMIT_CAPACITY: '5', RATE_LIMIT_REFILL_PER_SEC: '0.2' }
    : { RATE_LIMIT_CAPACITY: '100000', RATE_LIMIT_REFILL_PER_SEC: '1000' }),
};

if (which === 'main') {
  if (DATABASE_URL.startsWith('file:')) {
    mkdirSync(dirname(sqliteFile), { recursive: true });
    for (const f of [sqliteFile, `${sqliteFile}-wal`, `${sqliteFile}-shm`]) rmSync(f, { force: true });
  }
  for (const [cmd, args, cwd] of [
    ['pnpm', ['--filter', '@slate/db', 'migrate'], root],
    ['pnpm', ['--filter', '@slate/db', 'seed'], root],
    ['pnpm', ['exec', 'tsx', 'src/cli/e2e-seed.ts'], api],
  ]) {
    const r = spawnSync(cmd, args, { cwd, env: childEnv, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const logDir = resolve(here, '.results-logs');
mkdirSync(logDir, { recursive: true });
const log = createWriteStream(resolve(logDir, `${which}.log`), { flags: 'w' });
const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], { cwd: api, env: childEnv });
for (const s of [child.stdout, child.stderr]) {
  s.on('data', (d) => {
    log.write(d);
    process.stdout.write(d);
  });
}
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
