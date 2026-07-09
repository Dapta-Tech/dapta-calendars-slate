import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Db } from '@slate/db';
import { countOutbox, sql } from '@slate/db';
import { DB } from './tokens';

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
    return { status: db === 'up' ? 'ok' : 'degraded', service: 'slate-api', db, dialect: this.db.dialect };
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
    const body = { status: db === 'up' ? 'ready' : 'unavailable', service: 'slate-api', db, outbox };
    if (db !== 'up') throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
