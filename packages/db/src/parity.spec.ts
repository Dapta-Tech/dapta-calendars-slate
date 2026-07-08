import { describe, it, expect, beforeEach } from 'vitest';
import { hashManageToken } from '@slate/engine';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import {
  cancelBooking,
  checkHandleAvailable,
  confirmBooking,
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
import { createEventType, createTeam, setEventTypeHosts } from './crud';

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

  it('requiresConfirmation → booking is pending, host confirm → accepted', async () => {
    const { createEventType } = await import('./crud');
    const account = await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM account WHERE code='acme'`);
    const member = await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    const created = await createEventType(db, account!.id, member!.id, {
      slug: 'confirm-me',
      title: 'Needs Confirmation',
      lengthMinutes: 30,
      requiresConfirmation: true,
      scheduleId: null,
    });
    expect(created.ok).toBe(true);
    const av = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'confirm-me',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'confirm-me',
      startMs: new Date(av!.slots[0]!).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.booking.status).toBe('pending');
      const { confirmBooking } = await import('./parity');
      const conf = await confirmBooking(db, out.booking.uid);
      expect(conf.ok).toBe(true);
      const b = await resolveBooking(db, out.booking.uid);
      expect(b?.status).toBe('accepted');
    }
  });

  it('dispatchWebhooks signs the body with HMAC and posts to subscribers', async () => {
    const { createWebhook, dispatchWebhooks } = await import('./parity');
    await createWebhook(db, {
      accountId,
      // Public IP literal → the SSRF guard passes without a real DNS lookup,
      // keeping this HMAC assertion deterministic and offline-safe.
      subscriberUrl: 'https://198.51.100.10/hook',
      eventTriggers: ['booking.created'],
      secret: 's3cret',
    });
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const sent = await dispatchWebhooks(db, accountId, 'booking.created', { uid: 'x' }, fakeFetch);
    expect(sent).toBe(1);
    expect(calls[0]!.headers['X-Slate-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    // A non-matching event fires nothing.
    const none = await dispatchWebhooks(db, accountId, 'booking.cancelled', {}, fakeFetch);
    expect(none).toBe(0);
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

  it('H1 — a pending booking HOLDS the slot: a second booking at the same slot is rejected', async () => {
    const memberId = (await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    await createEventType(db, accountId, memberId, {
      slug: 'confirm-hold',
      title: 'Confirm Hold',
      lengthMinutes: 30,
      requiresConfirmation: true,
      scheduleId: null,
    });
    const av = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'confirm-hold',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const startMs = new Date(av!.slots[0]!).getTime();
    const first = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'confirm-hold',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.booking.status).toBe('pending');
    // A second booking at the same instant must NOT be created — the pending
    // booking holds the slot (this is what the PG EXCLUDE now enforces too).
    const second = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'confirm-hold',
      startMs,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('SLOT_TAKEN');
  });

  it('H2 — a team booking cannot overlap a host’s pending personal booking', async () => {
    const memberId = (await db.get<{ id: string }>((await import('drizzle-orm')).sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;

    // A team whose ONLY host is alex-rivera.
    const team = await createTeam(db, accountId, { name: 'Solo', slug: 'solo' });
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    const ev = await createEventType(db, accountId, null, {
      slug: 'solo-demo',
      title: 'Solo Demo',
      lengthMinutes: 30,
      schedulingType: 'round_robin',
      scheduleId: null,
      teamId: team.value.id,
    });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    await setEventTypeHosts(db, accountId, ev.value.id, [memberId]);

    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'solo',
      slug: 'solo-demo',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const slotX = new Date(avail!.slots[0]!).getTime();

    // Give alex a PENDING personal booking at slotX.
    await createEventType(db, accountId, memberId, {
      slug: 'pers-confirm',
      title: 'Personal Confirm',
      lengthMinutes: 30,
      requiresConfirmation: true,
      scheduleId: null,
    });
    const pending = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'pers-confirm',
      startMs: slotX,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
    });
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.booking.status).toBe('pending');

    // The team booking at slotX must fail — the only host is held by a pending.
    const teamBooked = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'solo',
      slug: 'solo-demo',
      startMs: slotX,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
    });
    expect(teamBooked.ok).toBe(false);
    if (!teamBooked.ok) expect(teamBooked.reason).toBe('SLOT_TAKEN');

    // Sanity: confirming the pending keeps the invariant (no crash / still one).
    if (pending.ok) {
      const conf = await confirmBooking(db, pending.booking.uid, accountId);
      expect(conf.ok).toBe(true);
    }
  });
});
