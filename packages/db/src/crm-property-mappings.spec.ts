import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from './index';
import { createEventType, getEventTypeById, updateEventType } from './crud';
import { loadBookingForCrmWrite } from './crm-refs';
import { createBooking, getAvailability } from './repository';
import { crmPropertyMappingsSchema } from '@slate/types';

/**
 * H2 (#108) — the `crm_property_mappings` column, and the contract that guards
 * what may go into it.
 *
 * The additive rule matters more here than the round-trip: NULL has to keep
 * meaning "never configured", because that is what every event type that
 * predates this migration reads as, and an event that reads as configured-with-
 * nothing would behave identically but say something different.
 */
describe('crm_property_mappings (H2, #108)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;

  const MAPPINGS = {
    hubspot: [
      { source: { kind: 'question' as const, name: 'budget' }, properties: ['annualrevenue'] },
      { source: { kind: 'attendee' as const, field: 'phone' as const }, properties: ['phone', 'mobilephone'] },
    ],
  };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
  });

  it('round-trips the document through create', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'mapped',
      title: 'Mapped',
      lengthMinutes: 30,
      crmPropertyMappings: MAPPINGS,
    });
    expect(created.ok).toBe(true);
    const view = await getEventTypeById(db, accountId, (created as { value: { id: string } }).value.id);
    expect(view!.crmPropertyMappings).toEqual(MAPPINGS);
  });

  it('reads NULL as never-configured on an event created without one', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'plain',
      title: 'Plain',
      lengthMinutes: 30,
    });
    const id = (created as { value: { id: string } }).value.id;
    expect((await getEventTypeById(db, accountId, id))!.crmPropertyMappings).toBeNull();
    // …and the column really is NULL, not an empty document.
    const row = await db.get<{ crm_property_mappings: unknown }>(
      sql`SELECT crm_property_mappings FROM event_type WHERE id = ${id}`,
    );
    expect(row!.crm_property_mappings).toBeNull();
  });

  it('leaves the document alone when an update omits it', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'mapped2',
      title: 'Mapped',
      lengthMinutes: 30,
      crmPropertyMappings: MAPPINGS,
    });
    const id = (created as { value: { id: string } }).value.id;
    await updateEventType(db, accountId, id, { title: 'Renamed' });
    const view = await getEventTypeById(db, accountId, id);
    expect(view!.title).toBe('Renamed');
    expect(view!.crmPropertyMappings).toEqual(MAPPINGS);
  });

  it('clears the document on an explicit null', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'mapped3',
      title: 'Mapped',
      lengthMinutes: 30,
      crmPropertyMappings: MAPPINGS,
    });
    const id = (created as { value: { id: string } }).value.id;
    await updateEventType(db, accountId, id, { crmPropertyMappings: null });
    expect((await getEventTypeById(db, accountId, id))!.crmPropertyMappings).toBeNull();
  });

  it('hands the CRM write context the mappings, answers and attendee details', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'ctx',
      title: 'Context call',
      lengthMinutes: 45,
      bookingFields: [{ name: 'budget', label: 'Budget', type: 'number' }],
      crmPropertyMappings: MAPPINGS,
    });
    expect(created.ok).toBe(true);

    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'ctx',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'ctx',
      startMs: new Date(avail!.slots[0]!.startUtc).getTime(),
      attendee: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        timeZone: 'America/New_York',
        phone: '+15551112222',
        notes: 'See you then',
        language: 'es',
      },
      answers: { budget: '50000' },
    });
    expect(booked.ok).toBe(true);

    const ctx = await loadBookingForCrmWrite(db, (booked as { booking: { uid: string } }).booking.uid);
    expect(ctx!.crmPropertyMappings).toEqual(MAPPINGS);
    expect(ctx!.responses).toEqual({ budget: '50000' });
    expect(ctx!.bookingFields.map((f) => f.name)).toEqual(['budget']);
    expect(ctx!.attendee).toEqual({
      phone: '+15551112222',
      notes: 'See you then',
      timeZone: 'America/New_York',
      // Accepted by `attendeeSchema` since v1 and DROPPED until H2 — a mapping
      // onto it would have had nothing to deliver.
      language: 'es',
    });
    expect(ctx!.eventTypeTitle).toBe('Context call');
    expect(ctx!.lengthMinutes).toBe(45);
    expect(ctx!.hostEmail).toBeTruthy();
  });

  describe('the contract refuses what the editor never offers', () => {
    it('refuses a destination property claimed by two sources', () => {
      const out = crmPropertyMappingsSchema.safeParse({
        hubspot: [
          { source: { kind: 'question', name: 'a' }, properties: ['jobtitle'] },
          { source: { kind: 'question', name: 'b' }, properties: ['JobTitle'] },
        ],
      });
      expect(out.success).toBe(false);
      expect(out.error!.issues[0]!.message).toMatch(/already mapped from another source/);
    });

    it('refuses an identity property as a target (ADR 0005)', () => {
      for (const property of ['email', 'firstname', 'LASTNAME']) {
        const out = crmPropertyMappingsSchema.safeParse({
          hubspot: [{ source: { kind: 'question', name: 'a' }, properties: [property] }],
        });
        expect(out.success).toBe(false);
        expect(out.error!.issues[0]!.message).toMatch(/identity property/);
      }
    });

    it('refuses the same source mapped twice', () => {
      const out = crmPropertyMappingsSchema.safeParse({
        hubspot: [
          { source: { kind: 'attendee', field: 'phone' }, properties: ['phone'] },
          { source: { kind: 'attendee', field: 'phone' }, properties: ['mobilephone'] },
        ],
      });
      expect(out.success).toBe(false);
      expect(out.error!.issues[0]!.message).toMatch(/mapped more than once/);
    });

    it('refuses an unknown attendee or event field', () => {
      expect(
        crmPropertyMappingsSchema.safeParse({
          hubspot: [{ source: { kind: 'attendee', field: 'email' }, properties: ['x'] }],
        }).success,
      ).toBe(false);
      // `manageUrl` is deliberately NOT in the catalog: the manage token is
      // stored hashed, so a link rebuilt at delivery would be dead.
      expect(
        crmPropertyMappingsSchema.safeParse({
          hubspot: [{ source: { kind: 'event', field: 'manageUrl' }, properties: ['x'] }],
        }).success,
      ).toBe(false);
    });

    it('accepts one source fanned out onto several properties', () => {
      expect(crmPropertyMappingsSchema.safeParse(MAPPINGS).success).toBe(true);
    });
  });
});
