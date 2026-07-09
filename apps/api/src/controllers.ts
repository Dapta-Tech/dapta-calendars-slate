import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Db } from '@slate/db';
import { sql } from '@slate/db';
import { DB } from './tokens';
import { openapiSpec } from './openapi';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Liveness + a real DB probe. Returns 200 even when the DB is degraded (so a
   * load balancer keeps the node while surfacing the dependency state); `db` is
   * 'up' | 'down'. E10: never fail the endpoint on a degraded dependency.
   */
  @Get()
  async health() {
    let db: 'up' | 'down' = 'down';
    try {
      await this.db.get(sql`SELECT 1 AS ok`);
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', service: 'slate-api', db, dialect: this.db.dialect };
  }
}

/** Public API documentation (E11): the OpenAPI JSON + a dependency-free viewer. */
@Controller()
export class DocsController {
  @Get('openapi.json')
  spec() {
    return openapiSpec;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    // No CDN (offline/CSP-safe): pretty-print the spec with a link to the raw JSON.
    return `<!doctype html><html><head><title>Slate API</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
pre{background:#f6f8fa;padding:1rem;border-radius:8px;overflow:auto}a{color:#2563eb}</style></head>
<body><h1>Slate API</h1><p>OpenAPI 3.1 · <a href="/openapi.json">/openapi.json</a></p>
<pre>${JSON.stringify(openapiSpec, null, 2).replace(/</g, '&lt;')}</pre></body></html>`;
  }
}
