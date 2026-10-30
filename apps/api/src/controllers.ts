import { Controller, Get, Header, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { ServerEnv } from '@slate/config/env';
import type { Db } from '@slate/db';
import { countOutbox, sql } from '@slate/db';
import { DB, ENV } from './tokens';
import { openapiFor } from './openapi';
import { renderDocsPage } from './docs-page';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async dbState(): Promise<'up' | 'down'> {
    try {
      await this.db.get(sql`SELECT 1 AS ok`);
      return 'up';
    } catch {
      return 'down';
    }
  }

  /**
   * LIVENESS + a real DB probe. Returns 200 even when the DB is degraded (so a
   * load balancer keeps the node while surfacing the dependency state); `db` is
   * 'up' | 'down'. E10: never fail the endpoint on a degraded dependency.
   */
  @Get()
  async health() {
    const db = await this.dbState();
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      service: 'calendars-api',
      db,
      dialect: this.db.dialect,
    };
  }

  /**
   * READINESS — distinct from liveness. A k8s readiness probe pulls the node out
   * of rotation when its hard dependency (the DB) is down: 503 when the DB is
   * unreachable, 200 otherwise. Also reports the outbox backlog (pending/failed)
   * so a stuck side-effect drainer is observable. Never throws on the backlog
   * query itself (best-effort).
   */
  @Get('ready')
  async ready() {
    const db = await this.dbState();
    let outbox: { pending: number; failed: number } | null = null;
    if (db === 'up') {
      try {
        outbox = {
          pending: await countOutbox(this.db, 'pending'),
          failed: await countOutbox(this.db, 'failed'),
        };
      } catch {
        outbox = null;
      }
    }
    const body = {
      status: db === 'up' ? 'ready' : 'unavailable',
      service: 'calendars-api',
      db,
      outbox,
    };
    if (db !== 'up') throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}

/**
 * The dashboard's base address as the reference links it: origin plus path, no
 * trailing slash. A query, fragment or credentials on the configured value are
 * dropped rather than discarding the address, so a tracking parameter never
 * costs the page its API keys link and icon.
 */
function appBase(value: string | undefined): string | undefined {
  try {
    const u = new URL(value ?? '');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * The MCP address as people paste it: kept exactly, trailing slash included
 * (with OAuth on it is the token audience), but never published with
 * credentials, a query or a fragment.
 */
function mcpAddress(value: string | undefined): string | undefined {
  try {
    const u = new URL(value ?? '');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.username || u.password || u.search || u.hash ? undefined : u.href;
  } catch {
    return undefined;
  }
}

/**
 * Public API documentation: OpenAPI JSON plus the interactive Scalar reference.
 * Both name this deployment's addresses from its configuration (API_PUBLIC_URL,
 * PUBLIC_APP_URL, MCP_PUBLIC_URL, DEVELOPER_DOCS_URL); one that is unset stays
 * relative or is left out, never a hardcoded host. ENV is required, not
 * optional: a module that forgot to provide it must fail to boot rather than
 * quietly serve relative addresses.
 */
@Controller()
export class DocsController {
  /** Normalized by the env schema (`cleanPublicUrl`): no trailing slash, query or credentials. */
  private readonly apiPublicUrl: string | undefined;
  /** The product the docs name: PRODUCT_NAME, else the mail sender name, as the email footer does. */
  private readonly productName: string;
  /** The dashboard's address, for the API keys page and the page icon. */
  private readonly appUrl: string | undefined;
  private readonly document: ReturnType<typeof openapiFor>;

  constructor(
    @Inject(ENV)
    env: Pick<ServerEnv, 'API_PUBLIC_URL'> &
      Partial<Pick<ServerEnv, 'PRODUCT_NAME' | 'MAIL_FROM_NAME' | 'PUBLIC_APP_URL' | 'MCP_ENABLED' | 'MCP_PUBLIC_URL' | 'DEVELOPER_DOCS_URL'>>,
  ) {
    this.apiPublicUrl = env.API_PUBLIC_URL;
    this.productName = env.PRODUCT_NAME?.trim() || env.MAIL_FROM_NAME?.trim() || 'Calendars';
    this.appUrl = appBase(env.PUBLIC_APP_URL);
    const mcpUrl = env.MCP_ENABLED !== false ? mcpAddress(env.MCP_PUBLIC_URL) : undefined;
    this.document = openapiFor(this.apiPublicUrl, this.productName, {
      keysUrl: this.appUrl && `${this.appUrl}/admin/developers/keys`,
      mcpUrl,
      docsUrl: env.DEVELOPER_DOCS_URL,
    });
  }

  @Get('openapi.json')
  spec() {
    return this.document;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    // The explorer fetches its document from the page's own origin (the prefix
    // kept): an absolute URL would be a cross-origin fetch, and CORS allows only
    // the web app, so /docs opened on any other host would show nothing.
    // Root-relative when unset: serving under a path prefix needs API_PUBLIC_URL.
    const explorerUrl = this.apiPublicUrl
      ? `${new URL(this.apiPublicUrl).pathname.replace(/\/$/, '')}/openapi.json`
      : '/openapi.json';
    return renderDocsPage({
      title: `${this.productName} API`,
      explorerUrl,
      openapiUrl: this.apiPublicUrl ? `${this.apiPublicUrl}/openapi.json` : '/openapi.json',
      iconUrl: this.appUrl && `${this.appUrl}/icon.svg`,
    });
  }
}
