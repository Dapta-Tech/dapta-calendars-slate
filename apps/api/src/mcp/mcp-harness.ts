import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { json, type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { createApiKey, createDb, migrate, seed, sql, type Db } from '@slate/db';
import { AppModule } from '../app.module';
import { McpGateway } from './mcp.gateway';
import { oidcOwnsBody } from '../oauth/oauth.settings';

/**
 * A real API for specs: the whole `AppModule` (so every `@Inject` is exercised
 * the way the tsx runtime exercises it) on a throwaway SQLite file, listening on
 * a random port, driven over HTTP with the official MCP client.
 */
export interface Harness {
  base: string;
  url: string;
  db: Db;
  app: NestExpressApplication;
  gateway: McpGateway;
  audit: string[];
  accountId: string;
  /** A second tenant, for cross-tenant checks. */
  other: { accountId: string; bookingUid: string; eventTypeId: string };
  /** Insert one more accepted booking on the seeded intro call; returns its uid. */
  newBooking(): Promise<string>;
  key(scopes: string[], opts?: { eventTypeIds?: string[]; expiresAtMs?: number }): Promise<string>;
  otherKey(scopes: string[]): Promise<string>;
  connect(token?: string, headers?: Record<string, string>): Promise<Client>;
  post(body: unknown, headers?: Record<string, string>, path?: string): Promise<Response>;
  close(): Promise<void>;
}

const ENV_KEYS = [
  'DATABASE_URL',
  'NODE_ENV',
  'OUTBOX_WORKER_ENABLED',
  'REQUEST_LOG_ENABLED',
  'MCP_ENABLED',
  'MCP_ALLOWED_ORIGINS',
  'MCP_ALLOWED_HOSTS',
  'MCP_RATE_LIMIT_CAPACITY',
  'MCP_RATE_LIMIT_REFILL_PER_SEC',
  'MCP_WRITE_RATE_LIMIT_CAPACITY',
  'MCP_WRITE_RATE_LIMIT_REFILL_PER_SEC',
  'MCP_TOOL_TIMEOUT_MS',
  'RATE_LIMIT_CAPACITY',
  'RATE_LIMIT_REFILL_PER_SEC',
  'RATE_LIMIT_ENABLED',
  'PUBLIC_APP_URL',
  'MCP_PUBLIC_URL',
  'OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_SIGNING_JWK',
  'OAUTH_ACCESS_TOKEN_TTL_SECONDS',
  'OAUTH_GRANT_TTL_DAYS',
  'OAUTH_REFRESH_REUSE_GRACE_SECONDS',
  'OAUTH_CIMD_ENABLED',
  'OAUTH_DCR_ENABLED',
  'OAUTH_DCR_EXTRA_REDIRECT_URIS',
  'OAUTH_AUTHORIZATION_SERVER',
  'OAUTH_JWKS_URL',
  'OAUTH_LINK_MAX_AGE_DAYS',
  'AUTH_LOCAL_STRICT',
  'PRODUCT_ANALYTICS_PROVIDER',
  'PRODUCT_ANALYTICS_KEY',
  'PRODUCT_ANALYTICS_HOST',
  'PRODUCT_ANALYTICS_ERRORS',
  'PRODUCT_ANALYTICS_INTERNAL_EMAILS',
] as const;

export type HarnessEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

export async function bootHarness(env: HarnessEnv = {}, opts: { port?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-spec-'));
  const url = `file:${join(dir, 'spec.db')}`;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    DATABASE_URL: url,
    NODE_ENV: 'test',
    OUTBOX_WORKER_ENABLED: 'false',
    REQUEST_LOG_ENABLED: 'false',
    PUBLIC_APP_URL: 'https://calendar.example.test',
    ...env,
  });

  const db = await createDb(url);
  await migrate(db);
  await seed(db);
  const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
  const other = await seedOtherTenant(db);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  // Same split as main.ts: the OAuth server parses its own bodies.
  const parse = json({ limit: '100kb' });
  app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => (oidcOwnsBody(req.path) ? next() : parse(req, res, next)));
  await app.listen(opts.port ?? 0, '127.0.0.1');
  // Providers read the environment while the app is built; put it back at once
  // so harnesses booted side by side do not leak settings into each other.
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const gateway = app.get(McpGateway);
  const audit: string[] = [];
  gateway.auditSink = (line) => audit.push(line);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const clients: Client[] = [];
  return {
    base,
    url: `${base}/mcp`,
    db,
    app,
    gateway,
    audit,
    accountId,
    other: { ...other },
    async newBooking() {
      const et = (await db.get<{ id: string; member_id: string }>(
        sql`SELECT id, member_id FROM event_type WHERE account_id = ${accountId} AND slug = 'intro-call'`,
      ))!;
      const uid = randomUUID();
      const start = Date.now() + (20 + Math.floor(Math.random() * 1000)) * 3_600_000;
      await db.run(
        sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
            VALUES (${randomUUID()}, ${accountId}, ${uid}, ${et.id}, ${et.member_id}, 'Intro Call', ${start}, ${start + 1_800_000}, 'accepted', ${null}, ${Date.now()}, ${Date.now()})`,
      );
      return uid;
    },
    key: async (scopes, opts) =>
      (await createApiKey(db, { accountId, name: 'spec', scopes, eventTypeIds: opts?.eventTypeIds, expiresAtMs: opts?.expiresAtMs })).plaintext,
    otherKey: async (scopes) => (await createApiKey(db, { accountId: other.accountId, name: 'other', scopes })).plaintext,
    async connect(token, headers = {}) {
      const client = new Client({ name: 'spec-client', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
        }),
      );
      clients.push(client);
      return client;
    },
    post: (body, headers = {}, path = '/mcp') =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await app.close();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A second workspace with one event type and one accepted booking. */
async function seedOtherTenant(db: Db) {
  const now = Date.now();
  const accountId = randomUUID();
  const memberId = randomUUID();
  const scheduleId = randomUUID();
  const eventTypeId = randomUUID();
  const bookingUid = randomUUID();
  await db.run(sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at) VALUES (${accountId}, 'globex', 'Globex', ${now}, ${now})`);
  await db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
        VALUES (${memberId}, ${accountId}, 'bo', 'Bo Other', 'bo@globex.test', 'UTC', ${scheduleId}, ${now})`,
  );
  await db.run(sql`UPDATE member SET role = 'owner' WHERE id = ${memberId}`);
  await db.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES (${scheduleId}, ${accountId}, ${memberId}, 'Hours', 'UTC', ${now})`);
  await db.run(
    sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
        VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([1, 2, 3, 4, 5])}, '09:00', '17:00', ${null})`,
  );
  await db.run(
    sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, schedule_id, hidden,
          minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval, created_at)
        VALUES (${eventTypeId}, ${accountId}, ${memberId}, 'chat', 'Globex Chat', 30, ${scheduleId}, 0, 120, 0, 0, 30, ${now})`,
  );
  const start = now + 5 * 86_400_000;
  const bookingId = randomUUID();
  await db.run(
    sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
        VALUES (${bookingId}, ${accountId}, ${bookingUid}, ${eventTypeId}, ${memberId}, 'Globex Chat', ${start}, ${start + 1_800_000}, 'accepted', ${null}, ${now}, ${now})`,
  );
  await db.run(
    sql`INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, created_at)
        VALUES (${randomUUID()}, ${bookingId}, 'Secret Person', 'secret@globex.test', 'UTC', ${now})`,
  );
  return { accountId, bookingUid, eventTypeId };
}

/** Parse the structured result of a successful tool call. */
export function structured<T = Record<string, unknown>>(result: unknown): T {
  const r = result as { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  if (r.isError) throw new Error(`tool error: ${r.content?.[0]?.text}`);
  return r.structuredContent as T;
}

export function errorText(result: unknown): string {
  const r = result as { isError?: boolean; content?: { text?: string }[] };
  if (!r.isError) throw new Error('expected a tool error');
  return r.content?.[0]?.text ?? '';
}

/** A label for an idempotency key; keeps secret scanners from reading test labels as credentials. */
export const idem = (label: string): string => label;
