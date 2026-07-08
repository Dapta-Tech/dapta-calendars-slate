import { describe, it, expect, beforeEach } from 'vitest';
import { hashManageToken } from '@slate/engine';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import {
  cancelBooking,
  checkHandleAvailable,
  createApiKey,
  createTeamBooking,
  getTeamAvailability,
  getTeamProfile,
  rescheduleBooking,
  reserveSlot,
  resolveBooking,
  updateBranding,
  verifyApiKey,
} from './parity';

async function firstSlotMs(db: Db, slug = 'intro-call'): Promise<number> {
  const a = await getAvailability(db, {
    accountCode: 'acme',
    handle: 'alex-rivera',
    slug,
    fromMs: Date.now(),
    toMs: Date.now() + 10 * 86_400_000,
  });
  return new Date(a!.slots[0]!).getTime();
}

describe('parity (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  it('rejects a booking missing a required intake field', async () => {
    const startMs = await firstSlotMs(db);
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      // no company → INVALID
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('INVALID');
  });

  it('reserving a slot blocks it from availability, and booking consumes the hold', async () => {
    const startMs = await firstSlotMs(db);
    const held = await reserveSlot(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
    });
    expect(held).not.toBeNull();
    // The held instant is no longer offered.
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    expect(a!.slots.map((s) => new Date(s).getTime())).not.toContain(startMs);
    // Booking with the reservation succeeds and releases the hold.
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
      reservationUid: held!.uid,
    });
    expect(out.ok).toBe(true);
  });

  it('reschedule verifies the manage token, moves the booking, and rotates the token', async () => {
    const startMs = await firstSlotMs(db);
    const created = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const token = created.manageToken;

    // Wrong token is rejected.
    const bad = await rescheduleBooking(db, { uid: created.booking.uid, newStartMs: startMs + 3 * 86_400_000, manageToken: 'nope' });
    expect(bad.ok).toBe(false);

    const newStart = startMs + 3 * 86_400_000 + 60 * 60_000;
    const moved = await rescheduleBooking(db, { uid: created.booking.uid, newStartMs: newStart, manageToken: token });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      // Old token no longer valid (rotated); new one is.
      const b = await resolveBooking(db, created.booking.uid);
      const meta = JSON.parse(String(b!.metadata)) as { _manage: { tokenHash: string } };
      expect(meta._manage.tokenHash).toBe(hashManageToken(moved.manageToken!));
      expect(meta._manage.tokenHash).not.toBe(hashManageToken(token));
    }
  });

  it('cancel verifies token and transitions status (never deletes)', async () => {
    const startMs = await firstSlotMs(db);
    const created = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    if (!created.ok) throw new Error('setup');
    const out = await cancelBooking(db, { uid: created.booking.uid, manageToken: created.manageToken, reason: 'test' });
    expect(out.ok).toBe(true);
    const b = await resolveBooking(db, created.booking.uid);
    expect(b?.status).toBe('cancelled');
  });

  it('team round-robin: availability unions hosts, booking assigns a free host', async () => {
    const profile = await getTeamProfile(db, 'acme', 'sales');
    expect(profile?.eventTypes.map((e) => e.slug)).toContain('team-demo');
    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    expect(avail!.slots.length).toBeGreaterThan(0);
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      startMs: new Date(avail!.slots[0]!).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.hostMemberId).toBeTruthy();
  });

  it('handle-available: taken vs free vs reserved', async () => {
    expect((await checkHandleAvailable(db, accountId, 'alex-rivera')).available).toBe(false);
    expect((await checkHandleAvailable(db, accountId, 'brand-new-handle')).available).toBe(true);
    expect((await checkHandleAvailable(db, accountId, 'api')).reason).toBe('reserved');
  });

  it('branding persists and api keys verify', async () => {
    const memberId = (await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    await updateBranding(db, memberId, { brandColor: '#123456', style: { density: 'compact' } });
    const m = await db.get<{ brand_color: string }>((await import('drizzle-orm')).sql`SELECT brand_color FROM member WHERE id=${memberId}`);
    expect(m?.brand_color).toBe('#123456');

    const key = await createApiKey(db, { accountId, name: 'test', scopes: ['availability:read'] });
    const principal = await verifyApiKey(db, key.plaintext);
    expect(principal?.accountId).toBe(accountId);
    expect(principal?.scopes).toContain('availability:read');
    expect(await verifyApiKey(db, 'wrong')).toBeNull();
  });
});
