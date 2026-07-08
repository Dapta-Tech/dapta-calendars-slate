import { Controller, Get, Inject } from '@nestjs/common';
import type { Db } from '@slate/db';
import { sql } from '@slate/db';
import { DB } from './tokens';

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
