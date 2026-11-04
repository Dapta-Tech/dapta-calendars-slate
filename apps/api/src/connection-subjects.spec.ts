import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { createConnection, createDb, getMemberIdentity, migrate, seed, sql, type Db } from '@slate/db';
import { InMemoryCalendarProvider, type CalendarSummary } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService, connectSubject } from './admin.service';
import { CalendarHttpError, type ConnectStart, type DiscoveredConnection } from './calendar.http-provider';

/**
 * A connect-capable provider that records which subjects it was asked about,
 * and can be told to refuse one subject or every calendar listing.
 */
class SubjectSpyProvider extends InMemoryCalendarProvider {
  started: string[] = [];
  asked: string[] = [];
  found = new Map<string, DiscoveredConnection[]>();
  refuseSubject: string | null = null;
  listed: CalendarSummary[] | Error = [];

  async startConnect(_provider: string, tenantKey: string): Promise<ConnectStart> {
    this.started.push(tenantKey);
    return { token: 'tok', connectUrl: 'https://connect.example.com/start' };
  }
  async discoverConnections(tenantKey: string): Promise<DiscoveredConnection[]> {
    this.asked.push(tenantKey);
    if (tenantKey === this.refuseSubject) throw new CalendarHttpError(500, 'discoverConnections', `boom ${tenantKey}`);
    return this.found.get(tenantKey) ?? [];
  }
  override listCalendars(): Promise<CalendarSummary[]> {
    return this.listed instanceof Error ? Promise.reject(this.listed) : Promise.resolve(this.listed);
  }
}

describe('connection subjects and the failures that used to be silent (BUGS-2734)', () => {
  let db: Db;
  let principal: { accountId: string; memberId: string; role: 'owner' };
  let iamUserId: string;
  let loginEmail: string;
  let warn: MockInstance<Logger['warn']>;

  const admin = (provider: InMemoryCalendarProvider) =>
    new AdminService(db, new CalendarEffects(provider, db), new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
  const warnings = () => warn.mock.calls.map((c) => String(c[0]));

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    principal = { accountId, memberId, role: 'owner' };
    const identity = (await getMemberIdentity(db, memberId))!;
    iamUserId = identity.iamUserId;
    loginEmail = identity.email!;
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('connectSubject trims and lower-cases the address', () => {
    expect(connectSubject('u1', '  Jose@GoncalvezGroup.com ')).toBe('u1-jose@goncalvezgroup.com');
  });

  it('starts a connect under the lower-case address, whatever was typed', async () => {
    const provider = new SubjectSpyProvider();
    await admin(provider).connectionToken(principal, 'outlook', ' Jose@Example.com ');
    expect(provider.started).toEqual([`${iamUserId}-jose@example.com`]);
  });

  it('discovers under the address as typed AND lower-cased, so older accounts are still found', async () => {
    const provider = new SubjectSpyProvider();
    provider.found.set(`${iamUserId}-Jose@Example.com`, [
      { connectionRef: 'ref-typed', provider: 'outlook', primaryEmail: 'Jose@Example.com' },
    ]);
    provider.found.set(`${iamUserId}-jose@example.com`, [
      { connectionRef: 'ref-lower', provider: 'outlook', primaryEmail: 'jose@example.com' },
    ]);
    const rows = await admin(provider).discoverConnections(principal, 'outlook', 'Jose@Example.com');
    expect(provider.asked).toEqual(
      expect.arrayContaining([`${iamUserId}-Jose@Example.com`, `${iamUserId}-jose@example.com`, iamUserId]),
    );
    expect(rows.map((r) => r.externalId).sort()).toEqual(['ref-lower', 'ref-typed']);
  });

  it('asks each subject once when the address is already lower-case', async () => {
    const provider = new SubjectSpyProvider();
    await admin(provider).discoverConnections(principal, 'google', loginEmail.toLowerCase());
    expect(provider.asked.length).toBe(new Set(provider.asked).size);
  });

  it('logs a subject that fails discovery, without the subject, and still records the others', async () => {
    const provider = new SubjectSpyProvider();
    provider.refuseSubject = iamUserId;
    provider.found.set(`${iamUserId}-new@example.com`, [
      { connectionRef: 'ref-new', provider: 'google', primaryEmail: 'new@example.com' },
    ]);
    const rows = await admin(provider).discoverConnections(principal, 'google', 'new@example.com');
    expect(rows.map((r) => r.externalId)).toContain('ref-new');
    expect(warnings()).toContain(
      'connection discovery failed for one subject: cause=CalendarHttpError op=discoverConnections status=500',
    );
    expect(warnings().join('\n')).not.toContain(iamUserId);
  });

  it('logs a failed email lookup on connect and still records the connection', async () => {
    const provider = new SubjectSpyProvider();
    provider.listed = new CalendarHttpError(404, 'listCalendars', 'Action with key list-calendar-lists not found');
    provider.found.set(`${iamUserId}-new@example.com`, [{ connectionRef: 'ref-noemail', provider: 'outlook' }]);
    const rows = await admin(provider).discoverConnections(principal, 'outlook', 'new@example.com');
    expect(rows.find((r) => r.externalId === 'ref-noemail')?.primaryEmail).toBeNull();
    expect(warnings()).toContain(
      'connection email lookup failed on connect: cause=CalendarHttpError op=listCalendars status=404',
    );
    expect(warnings().join('\n')).not.toContain('not found');
  });

  it('logs a failed email backfill on page load, and fills the email once the backend answers', async () => {
    const provider = new SubjectSpyProvider();
    await createConnection(db, {
      accountId: principal.accountId,
      memberId: principal.memberId,
      provider: 'outlook',
      externalId: 'ref-unknown',
    });
    provider.listed = new CalendarHttpError(404, 'listCalendars', 'Action not found');
    let rows = await admin(provider).listConnections(principal);
    expect(rows.find((r) => r.externalId === 'ref-unknown')?.primaryEmail).toBeNull();
    expect(warnings()).toContain('connection email backfill failed: cause=CalendarHttpError op=listCalendars status=404');

    // The backend recovered (the overlay fix): the next page load fills it in.
    provider.listed = [{ id: 'cal-1', name: 'Calendar', primaryEmail: 'Jose@Example.com', isPrimary: true }];
    rows = await admin(provider).listConnections(principal);
    expect(rows.find((r) => r.externalId === 'ref-unknown')?.primaryEmail).toBe('Jose@Example.com');
  });
});
