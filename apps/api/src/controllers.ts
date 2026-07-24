import { Controller, Get, Header, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Db } from '@slate/db';
import { countOutbox, sql } from '@slate/db';
import { DB } from './tokens';
import { openapiSpec } from './openapi';

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

/** Public API documentation: OpenAPI JSON plus an interactive Scalar explorer. */
@Controller()
export class DocsController {
  @Get('openapi.json')
  spec() {
    return openapiSpec;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dapta Calendars API</title>
<style>
body{margin:0;font:15px/1.55 system-ui,sans-serif;color:#17202a;background:#fff}
.intro{max-width:1040px;margin:0 auto;padding:32px 24px 8px}
h1{margin:0 0 8px}h2{margin-top:28px}code,pre{font-family:ui-monospace,SFMono-Regular,monospace}
pre{background:#111827;color:#f9fafb;padding:16px;border-radius:8px;overflow:auto}
.notice{border-left:4px solid #84cc16;background:#f7fee7;padding:12px 16px}
a{color:#2563eb}.pins{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
</style></head><body>
<main class="intro">
<h1>Dapta Calendars API</h1>
<p>OpenAPI 3.1 source: <a href="/openapi.json"><code>/openapi.json</code></a>.
This production-pilot surface covers discovery, availability, and the booking lifecycle.</p>
<div class="notice"><strong>Authentication:</strong> choose <em>Authorize</em> below and enter a
<code>dcl_</code> API key. Never put the key in a URL. Flow Studio should use Bearer auth from Vault,
raw JSON bodies, fire-and-forget off, and a stable <code>Idempotency-Key</code>.</div>
<h2>Required version pins</h2>
<div class="pins"><code>GET /v2/event-types</code><code>cal-api-version: 2024-06-14</code>
<code>GET /v2/slots</code><code>cal-api-version: 2024-09-04</code>
<code>POST /v2/bookings/{uid}/guests</code><code>cal-api-version: 2024-08-13</code>
<code>booking create/get/cancel/reschedule</code><code>cal-api-version: 2026-02-25</code></div>
<h2>Copy-paste discovery request</h2>
<pre>BASE_URL="https://calendars-api.dapta.ai"
curl "$BASE_URL/v2/event-types" \\
  --header "Authorization: Bearer $DCL_API_KEY" \\
  --header "cal-api-version: 2024-06-14"</pre>
<h2>Copy-paste slots request</h2>
<pre>curl --get "$BASE_URL/v2/slots" \\
  --header "Authorization: Bearer $DCL_API_KEY" \\
  --header "cal-api-version: 2024-09-04" \\
  --data-urlencode "eventTypeId=$EVENT_TYPE_ID" \\
  --data-urlencode "start=2026-07-24T00:00:00Z" \\
  --data-urlencode "end=2026-07-31T23:59:59Z" \\
  --data-urlencode "timeZone=America/Bogota"</pre>
<h2>Copy-paste booking request</h2>
<pre>curl "$BASE_URL/v2/bookings" \\
  --request POST \\
  --header "Authorization: Bearer $DCL_API_KEY" \\
  --header "cal-api-version: 2026-02-25" \\
  --header "Idempotency-Key: flow-run-123:create-booking" \\
  --header "Content-Type: application/json" \\
  --data '{"eventTypeId":"replace-with-event-type-id","start":"2026-07-24T15:00:00Z","attendee":{"name":"Test Customer","email":"customer@example.com","timeZone":"America/Bogota","language":"es"},"metadata":{"source":"flow-studio"},"bookingFieldsResponses":{"notes":"Created from an automation"}}'</pre>
<h2>Lifecycle</h2>
<pre>curl "$BASE_URL/v2/bookings/$BOOKING_UID" \\
  --header "Authorization: Bearer $DCL_API_KEY" \\
  --header "cal-api-version: 2026-02-25"

curl "$BASE_URL/v2/bookings/$BOOKING_UID/reschedule" --request POST \\
  --header "Authorization: Bearer $DCL_API_KEY" \\
  --header "cal-api-version: 2026-02-25" \\
  --header "Idempotency-Key: flow-run-123:reschedule" \\
  --header "Content-Type: application/json" \\
  --data '{"start":"2026-07-25T16:00:00Z","reschedulingReason":"Customer requested a later time"}'</pre>
<p>Repository guides: <code>API-CONTRACT.md</code>, <code>FLOW-STUDIO-QUICKSTART.md</code>, and
<code>CAL-COMPATIBILITY.md</code>.</p>
</main>
<script id="api-reference" data-url="/openapi.json" data-configuration='{"theme":"default","hideModels":false}'></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
<noscript><p class="intro">JavaScript is required for the interactive explorer. Use
<a href="/openapi.json">the raw OpenAPI document</a> instead.</p></noscript>
</body></html>`;
  }
}
