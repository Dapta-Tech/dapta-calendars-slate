import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider, InMemoryCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import type { ConnectStart } from './calendar.http-provider';
import { bootHarness } from './mcp/mcp-harness';

/**
 * A provider with the connect capability whose handshake is a spy: it counts
 * the calls and can be made to fail the way a rate-limited backend does.
 */
class ConnectSpyProvider extends InMemoryCalendarProvider {
  starts = 0;
  failWith: Error | null = null;
  async startConnect(_provider: string, _tenantKey: string): Promise<ConnectStart> {
    this.starts += 1;
    if (this.failWith) throw this.failWith;
    return { token: 'tok', connectUrl: 'https://connect.example.com/start' };
  }
  async discoverConnections() {
    return [];
  }
}

/**
 * The connections page asks "is calendar sync on?" on every load. That answer
 * must come from configuration, never from starting a connect: each real
 * handshake creates provider-side state and spends the provider's rate limit.
 */
describe('connection status and the connect handshake', () => {
  let db: Db;
  let principal: { accountId: string; memberId: string; role: 'owner' };

  const admin = (provider: InMemoryCalendarProvider | DisabledCalendarProvider) =>
    new AdminService(
      db,
      new CalendarEffects(provider, db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    principal = { accountId, memberId, role: 'owner' };
  });

  it('reports sync on without starting a connect', () => {
    const provider = new ConnectSpyProvider();
    const status = admin(provider).connectionStatus();
    expect(status.enabled).toBe(true);
    expect(provider.starts).toBe(0);
  });

  it('reports sync off with no external provider (the OSS default)', () => {
    expect(admin(new DisabledCalendarProvider()).connectionStatus().enabled).toBe(false);
  });

  it('answers a failed handshake with a retryable 503 that keeps the cause', async () => {
    const provider = new ConnectSpyProvider();
    const cause = new Error('connect backend refused (429)');
    provider.failWith = cause;
    let error: unknown;
    try {
      await admin(provider).connectionToken(principal, 'google', 'alex@example.com');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ error: 'CONNECT_UNAVAILABLE' });
    expect((error as ServiceUnavailableException).cause).toBe(cause);
    expect(provider.starts).toBe(1);
  });

  it('still starts a connect the host asked for', async () => {
    const provider = new ConnectSpyProvider();
    const start = await admin(provider).connectionToken(principal, 'google', 'alex@example.com');
    expect(start).toMatchObject({ enabled: true, connectUrl: 'https://connect.example.com/start' });
    expect(provider.starts).toBe(1);
  });
});

describe('GET /v1/connections/status', () => {
  it('needs a host session, like the other connection routes', async () => {
    const h = await bootHarness();
    try {
      const res = await fetch(`${h.base}/v1/connections/status`);
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
