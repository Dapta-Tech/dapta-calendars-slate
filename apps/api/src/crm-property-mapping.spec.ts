import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createBooking,
  createDb,
  createEventType,
  getAvailability,
  loadEncryptionKey,
  migrate,
  seed,
  sql,
  upsertAccountIntegration,
  type Db,
} from '@slate/db';
import {
  CrmPropertyError,
  DisabledCrmProvider,
  type CrmContactInput,
  type CrmContactResult,
  type CrmMeetingInput,
  type CrmMeetingUpdate,
  type CrmProperty,
  type CrmProvider,
} from '@slate/crm';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import type { CrmPropertyMappings } from '@slate/types';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal } from './auth.service';
import { CalendarEffects } from './calendar-effects';
import { CrmEffects } from './crm-effects';
import { CrmPropertyCatalogService } from './crm-property-catalog';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { OutboxWorker } from './outbox.worker';

/**
 * H2 (#108) — property mapping, from the stored column to the wire.
 *
 * The load-bearing assertion is the one the feature's whole argument rests on:
 * a booking with a mapped answer produces a contact write carrying ONLY the
 * mapped properties, and identity is never in it (ADR 0005).
 *
 * The property list is stubbed HERE, at the port boundary, and nowhere in
 * product code — the adapter under a real token still talks to the vendor.
 */
const KEY_B64 = randomBytes(32).toString('base64');
const KEY = loadEncryptionKey(KEY_B64);
const TOKEN = 'pat-live-test-0000-4242';

const ENV: ServerEnv = loadServerEnv({
  NODE_ENV: 'test',
  CRM_PROVIDER: 'hubspot',
  INTEGRATION_ENCRYPTION_KEY: KEY_B64,
} as NodeJS.ProcessEnv);

/** The portal a host would be mapping against. */
const PORTAL: CrmProperty[] = [
  base({ name: 'annualrevenue', label: 'Annual revenue', type: 'number', fieldType: 'number' }),
  base({ name: 'phone', label: 'Phone number', fieldType: 'phonenumber' }),
  base({ name: 'jobtitle', label: 'Job title' }),
  base({
    name: 'tier',
    label: 'Tier',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { value: 'smb', label: 'SMB' },
      { value: 'mid', label: 'Mid-market' },
    ],
  }),
  base({
    // A MULTI-select, so the single/multi enumeration split has something to
    // be wrong against.
    name: 'stack',
    label: 'Tech stack',
    type: 'enumeration',
    fieldType: 'checkbox',
    options: [
      { value: 'react', label: 'React' },
      { value: 'vue', label: 'Vue' },
    ],
  }),
  base({ name: 'last_booking_at', label: 'Last booking', type: 'datetime' }),
  // Present in the portal and NEVER offerable: the four exclusion flags plus
  // identity. If any of these reach a mapping, the filter is broken.
  base({ name: 'hs_calculated', label: 'Calculated', calculated: true }),
  base({ name: 'hs_archived', label: 'Archived', archived: true }),
  base({ name: 'hs_hidden', label: 'Hidden', hidden: true }),
  base({ name: 'hs_readonly', label: 'Read only', readOnlyValue: true }),
  base({ name: 'email', label: 'Email' }),
  base({ name: 'firstname', label: 'First name' }),
];

function base(over: Partial<CrmProperty> & { name: string }): CrmProperty {
  return {
    label: over.name,
    type: 'string',
    fieldType: 'text',
    options: [],
    archived: false,
    calculated: false,
    hidden: false,
    readOnlyValue: false,
    ...over,
  };
}

class FakeCrm implements CrmProvider {
  readonly enabled = true;
  readonly name = 'hubspot';
  readonly requiredScopes: readonly string[] = [];
  readonly contacts: CrmContactInput[] = [];
  readonly meetings: CrmMeetingInput[] = [];
  propertyCalls = 0;
  /** Property names the "portal" will reject once each, in order. */
  rejectProperties: string[] = [];
  listFails: Error | null = null;

  verifyCredential(): Promise<void> {
    return Promise.resolve();
  }
  resolveContact(input: CrmContactInput): Promise<CrmContactResult> {
    this.contacts.push(input);
    const bad = this.rejectProperties.find((p) => p in (input.properties ?? {}));
    if (bad) {
      this.rejectProperties = this.rejectProperties.filter((p) => p !== bad);
      return Promise.reject(new CrmPropertyError(`Property "${bad}" does not exist`, bad));
    }
    return Promise.resolve({ contactId: 'contact-1', created: false });
  }
  listContactProperties(): Promise<CrmProperty[]> {
    this.propertyCalls++;
    if (this.listFails) return Promise.reject(this.listFails);
    return Promise.resolve(PORTAL);
  }
  createMeeting(input: CrmMeetingInput): Promise<{ meetingId: string }> {
    this.meetings.push(input);
    return Promise.resolve({ meetingId: 'meet-1' });
  }
  updateMeeting(_input: CrmMeetingUpdate): Promise<void> {
    return Promise.resolve();
  }
}

class DisabledCalendar {
  readonly enabled = false;
  readonly conferencingLabel = null;
}

/** Resolves whichever principal the test set. */
class FakeAuth {
  current!: HostPrincipal;
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

describe('CRM property mapping (H2, #108)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let crm: FakeCrm;
  let catalog: CrmPropertyCatalogService;
  let effects: CrmEffects;

  const settle = () => new Promise((r) => setImmediate(r));

  function makeWorker(): OutboxWorker {
    return new OutboxWorker(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendar() as never, db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
      new DaptaSyncEffects(ENV),
      effects,
    );
  }

  /** An event type with intake questions and the given mappings. */
  async function eventTypeWith(mappings: CrmPropertyMappings | null): Promise<string> {
    const created = await createEventType(db, accountId, memberId, {
      slug: `mapped-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Mapped call',
      lengthMinutes: 30,
      bookingFields: [
        { name: 'budget', label: 'Budget', type: 'number' },
        { name: 'role', label: 'Role', type: 'text' },
        { name: 'tier', label: 'Tier', type: 'select', options: ['SMB', 'Enterprise'] },
      ],
      crmPropertyMappings: mappings,
    });
    if (!created.ok) throw new Error('event type create failed');
    return created.value.slug;
  }

  async function book(slug: string, answers: Record<string, unknown>): Promise<string> {
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs: new Date(avail!.slots[0]!.startUtc).getTime(),
      attendee: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        timeZone: 'America/New_York',
        phone: '+15551112222',
        notes: 'Looking forward to it',
        language: 'es',
      },
      answers,
    });
    if (!booked.ok) throw new Error(`seed booking failed: ${booked.reason}`);
    return booked.booking.uid;
  }

  /** Accept, drain, and hand back the single contact write that resulted. */
  async function deliver(uid: string): Promise<CrmContactInput> {
    effects.onBookingAccepted(uid);
    await settle();
    await makeWorker().drainOnce(Date.now());
    const last = crm.contacts.at(-1);
    if (!last) throw new Error('no contact write was made');
    return last;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
    crm = new FakeCrm();
    catalog = new CrmPropertyCatalogService(crm, db, ENV);
    effects = new CrmEffects(crm, db, ENV, catalog);
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
  });

  // --- THE assertion (#64, ADR 0005) --------------------------------------

  it('a mapped answer reaches the contact write, and identity never does', async () => {
    const slug = await eventTypeWith({
      hubspot: [
        { source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] },
        { source: { kind: 'question', name: 'role' }, properties: ['jobtitle'] },
        { source: { kind: 'attendee', field: 'phone' }, properties: ['phone'] },
        { source: { kind: 'event', field: 'startUtc' }, properties: ['last_booking_at'] },
      ],
    });
    const uid = await book(slug, { budget: '50000', role: 'CTO' });
    const write = await deliver(uid);

    expect(write.properties).toEqual({
      annualrevenue: '50000',
      jobtitle: 'CTO',
      phone: '+15551112222',
      last_booking_at: expect.stringMatching(/^\d+$/),
    });
    // Identity travels on its OWN fields and is never in the mapped bag — the
    // adapter builds the PATCH from `properties` alone for a found contact.
    for (const key of ['email', 'firstname', 'lastname']) {
      expect(write.properties).not.toHaveProperty(key);
    }
    expect(write.email).toBe('ada@example.com');
    // The meeting body still carries every answer, mapped or not: it is the
    // record of what the invitee said in THIS booking (#64).
    expect(crm.meetings.at(-1)!.body).toContain('50000');
  });

  it('sends nothing extra — and reads no property list — when nothing is mapped', async () => {
    const slug = await eventTypeWith(null);
    const write = await deliver(await book(slug, { budget: '1' }));

    expect(write.properties ?? {}).toEqual({});
    // The catalog is only consulted when there is something to map, so an
    // unmapped event type costs exactly what it did before H2.
    expect(crm.propertyCalls).toBe(0);
  });

  it('omits an enumeration value the portal does not have, and keeps the rest', async () => {
    const slug = await eventTypeWith({
      hubspot: [
        { source: { kind: 'question', name: 'tier' }, properties: ['tier'] },
        { source: { kind: 'question', name: 'role' }, properties: ['jobtitle'] },
      ],
    });
    // "Enterprise" is not one of the portal's options. Sending it would 400 and
    // fail the WHOLE contact write, so it is dropped and `jobtitle` survives.
    const write = await deliver(await book(slug, { tier: 'Enterprise', role: 'CTO' }));
    expect(write.properties).toEqual({ jobtitle: 'CTO' });
  });

  it('matches an enumeration option on its label, normalized', async () => {
    const slug = await eventTypeWith({
      hubspot: [{ source: { kind: 'question', name: 'tier' }, properties: ['tier'] }],
    });
    const write = await deliver(await book(slug, { tier: 'smb' }));
    expect(write.properties).toEqual({ tier: 'smb' });
  });

  it('drops a property the portal rejects and still lands the booking', async () => {
    crm.rejectProperties = ['jobtitle'];
    const slug = await eventTypeWith({
      hubspot: [
        { source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] },
        { source: { kind: 'question', name: 'role' }, properties: ['jobtitle'] },
      ],
    });
    const uid = await book(slug, { budget: '50000', role: 'CTO' });
    await deliver(uid);

    // Two attempts: the full bag, then the same minus the named property.
    expect(crm.contacts).toHaveLength(2);
    expect(crm.contacts[1]!.properties).toEqual({ annualrevenue: '50000' });
    // The meeting still exists — a stale mapping never costs a booking its
    // CRM record.
    expect(crm.meetings).toHaveLength(1);
  });

  it('delivers with NO mapped properties when a second one is rejected', async () => {
    crm.rejectProperties = ['jobtitle', 'annualrevenue'];
    const slug = await eventTypeWith({
      hubspot: [
        { source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] },
        { source: { kind: 'question', name: 'role' }, properties: ['jobtitle'] },
      ],
    });
    await deliver(await book(slug, { budget: '50000', role: 'CTO' }));

    expect(crm.contacts).toHaveLength(3);
    expect(crm.contacts[2]!.properties).toEqual({});
    expect(crm.meetings).toHaveLength(1);
  });

  it('delivers without mapped properties when the property list is unreachable', async () => {
    crm.listFails = new Error('upstream 503');
    const slug = await eventTypeWith({
      hubspot: [{ source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] }],
    });
    const write = await deliver(await book(slug, { budget: '50000' }));

    // Mapped properties are best-effort; the booking is not. Losing the meeting
    // because a property list was briefly down is the worse failure.
    expect(write.properties ?? {}).toEqual({});
    expect(crm.meetings).toHaveLength(1);
  });

  it('maps attendee notes, time zone and language', async () => {
    const slug = await eventTypeWith({
      hubspot: [
        { source: { kind: 'attendee', field: 'notes' }, properties: ['jobtitle'] },
        { source: { kind: 'attendee', field: 'language' }, properties: ['phone'] },
      ],
    });
    const write = await deliver(await book(slug, {}));
    expect(write.properties).toEqual({ jobtitle: 'Looking forward to it', phone: 'es' });
  });

  // --- The cached catalog --------------------------------------------------

  describe('CrmPropertyCatalogService', () => {
    it('filters out archived, calculated, hidden, read-only and identity', async () => {
      const out = await catalog.catalog(accountId);
      expect(out.connected).toBe(true);
      expect(out.reason).toBeNull();
      expect(out.properties.map((p) => p.name).sort()).toEqual([
        'annualrevenue',
        'jobtitle',
        'last_booking_at',
        'phone',
        'stack',
        'tier',
      ]);
    });

    it('serves the cache, and Refresh goes back to the portal', async () => {
      await catalog.catalog(accountId);
      await catalog.catalog(accountId);
      expect(crm.propertyCalls).toBe(1);

      await catalog.catalog(accountId, { refresh: true });
      expect(crm.propertyCalls).toBe(2);
    });

    it('collapses concurrent reads into ONE upstream call', async () => {
      await Promise.all([
        catalog.catalog(accountId, { refresh: true }),
        catalog.catalog(accountId, { refresh: true }),
        catalog.catalog(accountId, { refresh: true }),
      ]);
      expect(crm.propertyCalls).toBe(1);
    });

    it('says `not_connected` rather than erroring when nothing is wired', async () => {
      const other = 'account-two';
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${other}, 'other', 'Other Co', ${Date.now()})`,
      );
      const out = await catalog.catalog(other);
      expect(out).toMatchObject({ connected: false, reason: 'not_connected', properties: [] });
    });

    it('says `disabled` on a deployment with no adapter', async () => {
      const off = new CrmPropertyCatalogService(new DisabledCrmProvider(), db, ENV);
      expect(await off.catalog(accountId)).toMatchObject({
        provider: null,
        connected: false,
        reason: 'disabled',
      });
    });

    it('keeps serving the last good list when the portal goes down', async () => {
      await catalog.catalog(accountId);
      crm.listFails = new Error('upstream 503');
      const out = await catalog.catalog(accountId, { refresh: true });

      // A stale list beats no list: the host can still see their mappings, and
      // the reason tells the editor to say so.
      expect(out.reason).toBe('unavailable');
      expect(out.properties).toHaveLength(6);
    });

    it('drops the cached list on invalidate, so a reconnect cannot serve the old portal', async () => {
      await catalog.catalog(accountId);
      catalog.invalidate(accountId);
      await catalog.catalog(accountId);
      expect(crm.propertyCalls).toBe(2);
    });
  });
});

/**
 * The SAVE-TIME compatibility refusal (#64).
 *
 * The picker already filters, so reaching this needs a hand-written request or
 * a stale editor. It exists anyway because "unreachable beats diagnosable":
 * without it, an incompatible pair saves cleanly and then quietly delivers
 * nothing, one booking at a time, in an outbox nobody watches.
 */
describe('save-time mapping compatibility (H2, #108)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let crud: AdminCrudController;
  let auth: FakeAuth;
  let crm: FakeCrm;
  let catalog: CrmPropertyCatalogService;

  const QUESTIONS = [
    { name: 'budget', label: 'Budget', type: 'number' },
    { name: 'role', label: 'Role', type: 'text' },
    { name: 'friends', label: 'Guests', type: 'guests' },
  ];

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
    crm = new FakeCrm();
    catalog = new CrmPropertyCatalogService(crm, db, ENV);
    auth = new FakeAuth();
    auth.current = { memberId, accountId, role: 'owner' } as HostPrincipal;
    crud = new AdminCrudController(
      db,
      auth as unknown as AuthService,
      undefined,
      catalog,
    );
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
  });

  const body = (mappings: unknown, slug = 'compat') => ({
    slug,
    title: 'Compat',
    lengthMinutes: 30,
    bookingFields: QUESTIONS,
    crmPropertyMappings: mappings,
  });

  it('refuses a text answer aimed at a number property', async () => {
    await expect(
      crud.createEventType({} as never, body({
        hubspot: [{ source: { kind: 'question', name: 'role' }, properties: ['annualrevenue'] }],
      })),
    ).rejects.toMatchObject({ response: { error: 'CRM_MAPPING_INCOMPATIBLE' } });
  });

  it('refuses a single-choice answer aimed at a multi-select', async () => {
    await expect(
      crud.createEventType({} as never, body({
        hubspot: [{ source: { kind: 'question', name: 'role' }, properties: ['stack'] }],
      })),
    ).rejects.toMatchObject({ response: { error: 'CRM_MAPPING_INCOMPATIBLE' } });
  });

  it('refuses `guests`, which is not a contact (#63)', async () => {
    await expect(
      crud.createEventType({} as never, body({
        hubspot: [{ source: { kind: 'question', name: 'friends' }, properties: ['jobtitle'] }],
      })),
    ).rejects.toMatchObject({ response: { error: 'CRM_MAPPING_INCOMPATIBLE' } });
  });

  it('accepts a compatible pair', async () => {
    const out = await crud.createEventType({} as never, body({
      hubspot: [
        { source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] },
        { source: { kind: 'question', name: 'role' }, properties: ['jobtitle'] },
      ],
    }));
    expect((out as { crmPropertyMappings: unknown }).crmPropertyMappings).toBeTruthy();
  });

  it('ALLOWS a target the portal no longer has', async () => {
    // The broken-mapping state the editor draws in red. Refusing here would
    // make an unrelated edit unsaveable because somebody deleted a property.
    const out = await crud.createEventType({} as never, body({
      hubspot: [{ source: { kind: 'question', name: 'budget' }, properties: ['deleted_in_portal'] }],
    }));
    expect(out).toBeTruthy();
  });

  it('ALLOWS anything when the portal cannot be reached', async () => {
    crm.listFails = new Error('upstream 503');
    const out = await crud.createEventType({} as never, body({
      hubspot: [{ source: { kind: 'question', name: 'role' }, properties: ['annualrevenue'] }],
    }));
    // Blocking an event-type save because the CRM is briefly down is the worse
    // trade — the picker already filtered, and delivery omits what it cannot
    // coerce.
    expect(out).toBeTruthy();
  });

  it('checks a PARTIAL update against the questions the save leaves behind', async () => {
    const created = (await crud.createEventType({} as never, body({}, 'partial'))) as { id: string };
    // No `bookingFields` in this payload: the event keeps the three it has, so
    // the mapping must be judged against THOSE, not against an empty list.
    await expect(
      crud.updateEventType({} as never, created.id, {
        crmPropertyMappings: {
          hubspot: [{ source: { kind: 'question', name: 'role' }, properties: ['annualrevenue'] }],
        },
      }),
    ).rejects.toMatchObject({ response: { error: 'CRM_MAPPING_INCOMPATIBLE' } });

    const ok = await crud.updateEventType({} as never, created.id, {
      crmPropertyMappings: {
        hubspot: [{ source: { kind: 'question', name: 'budget' }, properties: ['annualrevenue'] }],
      },
    });
    expect(ok).toBeTruthy();
  });
});
