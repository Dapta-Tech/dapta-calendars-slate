import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from './index';
import { createEventType, getEventTypeById, updateEventType } from './crud';
import {
  applyReminderCopyForward,
  defaultEventReminders,
  effectiveReminders,
  parseEventReminders,
} from './reminders';
import { upsertNotificationSetting } from './notification-settings';

/**
 * Reminders moved from the account to the event type (#68). The two things that
 * must hold for an existing host: nothing they configured is lost, and nothing
 * they never configured starts arriving.
 */
describe('per-event reminders — parse, defaults, and the copy-forward', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let eventTypeId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const member = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    memberId = member.id;
    accountId = member.account_id;
    eventTypeId = (await db.get<{ id: string }>(
      sql`SELECT id FROM event_type WHERE slug='intro-call' AND account_id=${accountId}`,
    ))!.id;
  });

  const storedColumn = async (id = eventTypeId) =>
    (await db.get<{ reminders: unknown }>(sql`SELECT reminders FROM event_type WHERE id = ${id}`))!.reminders;

  it('NULL means "never configured" and reads back as the shipped defaults', () => {
    expect(parseEventReminders(null)).toBeNull();
    const shipped = effectiveReminders(null);
    expect(shipped.filter((r) => r.kind === 'reminder').map((r) => r.leadMinutes)).toEqual([1440, 60]);
    expect(shipped.find((r) => r.kind === 'follow_up')!.enabled).toBe(false);
    expect(shipped).toEqual(defaultEventReminders());
  });

  it('an EMPTY list is a deliberate "none" and survives the read', async () => {
    await updateEventType(db, accountId, eventTypeId, { reminders: [] });
    expect(parseEventReminders(await storedColumn())).toEqual([]);
    expect(effectiveReminders([])).toEqual([]);
  });

  it('drops malformed rows rather than throwing — bad data never breaks mail', () => {
    const parsed = parseEventReminders(
      JSON.stringify([
        { id: 'ok', kind: 'reminder', enabled: true, leadMinutes: 60, subject: null, body: null },
        { id: 'too-soon', kind: 'reminder', enabled: true, leadMinutes: 1 }, // below the 5-minute floor
        { id: 'too-late', kind: 'reminder', enabled: true, leadMinutes: 60 * 24 * 400 },
        'not an object',
        { id: 'ok', kind: 'reminder', enabled: true, leadMinutes: 30 }, // duplicate id
      ]),
    );
    expect(parsed!.map((r) => r.id)).toEqual(['ok']);
    expect(parsed![0]!.leadMinutes).toBe(60);
  });

  it('copy-forward gives an event type its ACCOUNT’s current times and copy', async () => {
    await upsertNotificationSetting(db, accountId, 'attendee_reminder', {
      reminderLeadMinutes: [2880, 90],
      subject: 'Coming up: {{event_title}}',
      body: 'See you at {{start_time}}.',
    });
    await upsertNotificationSetting(db, accountId, 'follow_up', { enabled: true, reminderLeadMinutes: [180] });

    await applyReminderCopyForward(db);

    const rows = parseEventReminders(await storedColumn())!;
    const reminders = rows.filter((r) => r.kind === 'reminder');
    expect(reminders.map((r) => r.leadMinutes)).toEqual([2880, 90]);
    expect(reminders.every((r) => r.enabled)).toBe(true);
    expect(reminders.every((r) => r.subject === 'Coming up: {{event_title}}')).toBe(true);
    const followUp = rows.find((r) => r.kind === 'follow_up')!;
    expect(followUp.enabled).toBe(true);
    expect(followUp.leadMinutes).toBe(180);
  });

  it('an account that never touched Settings gets the shipped times, follow-up OFF', async () => {
    await applyReminderCopyForward(db);
    const rows = parseEventReminders(await storedColumn())!;
    expect(rows.filter((r) => r.kind === 'reminder').map((r) => r.leadMinutes)).toEqual([1440, 60]);
    expect(rows.find((r) => r.kind === 'follow_up')!.enabled).toBe(false);
  });

  it('a disabled account reminder carries its OFF state forward, not a fresh ON', async () => {
    await upsertNotificationSetting(db, accountId, 'attendee_reminder', { enabled: false });
    await applyReminderCopyForward(db);
    const rows = parseEventReminders(await storedColumn())!;
    expect(rows.filter((r) => r.kind === 'reminder').every((r) => r.enabled)).toBe(false);
  });

  it('is idempotent: a second run never overwrites what the host edited after', async () => {
    await applyReminderCopyForward(db);
    await updateEventType(db, accountId, eventTypeId, {
      reminders: [{ id: 'mine', kind: 'reminder', enabled: true, leadMinutes: 15, subject: 'Mine', body: null }],
    });
    await applyReminderCopyForward(db);
    const rows = parseEventReminders(await storedColumn())!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('mine');
    expect(rows[0]!.leadMinutes).toBe(15);
  });

  it('a brand-new event type is born pre-filled, so no booking page silently forgets', async () => {
    const created = await createEventType(db, accountId, memberId, {
      slug: 'fresh',
      title: 'Fresh',
      lengthMinutes: 30,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const stored = parseEventReminders(await storedColumn(created.value.id))!;
    expect(stored).toEqual(defaultEventReminders());
    // And the view surfaces the same list the editor will open on.
    const view = await getEventTypeById(db, accountId, created.value.id);
    expect(view!.reminders).toEqual(defaultEventReminders());
  });

  it('create honours an EXPLICIT empty list — so a create surface must send the shipped one', async () => {
    // `[] ?? default` is `[]`: an empty list on create is a deliberate "no
    // reminders", not "unspecified". That is correct here and is exactly why
    // the event-type form seeds its state with `defaultEventReminders()` rather
    // than `[]` — a create screen that submits what it displays.
    const created = await createEventType(db, accountId, memberId, {
      slug: 'deliberately-silent',
      title: 'Deliberately silent',
      lengthMinutes: 30,
      reminders: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(parseEventReminders(await storedColumn(created.value.id))).toEqual([]);
    expect(created.value.reminders).toEqual([]);
  });

  it('the cap holds on write: at most 10 reminders and one follow-up are stored', async () => {
    await updateEventType(db, accountId, eventTypeId, {
      reminders: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `r${i}`,
          kind: 'reminder' as const,
          enabled: true,
          leadMinutes: 60 + i,
          subject: null,
          body: null,
        })),
        { id: 'f1', kind: 'follow_up' as const, enabled: true, leadMinutes: 60, subject: null, body: null },
        { id: 'f2', kind: 'follow_up' as const, enabled: true, leadMinutes: 120, subject: null, body: null },
      ],
    });
    const rows = parseEventReminders(await storedColumn())!;
    expect(rows.filter((r) => r.kind === 'reminder')).toHaveLength(10);
    expect(rows.filter((r) => r.kind === 'follow_up')).toHaveLength(1);
  });
});

/**
 * The copy-forward is the one piece of this change that runs ONCE against a
 * live production database, and it reads a JSON column on one table to write a
 * JSON column on another — the exact place the two dialects differ (`jsonb`
 * round-trips as a JS value on Postgres, as text on SQLite). The suite above
 * proves it on SQLite; this proves it on the engine that is the source of
 * truth. Skipped unless DATABASE_URL points at Postgres, like repository.pg.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('per-event reminders on real Postgres', () => {
  let db: Db;
  let accountId: string;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ account_id: string }>(
      sql`SELECT account_id FROM member WHERE handle='alex-rivera'`,
    ))!.account_id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('reads and writes the jsonb column, and copies an account forward', async () => {
    // A fresh event type in its own account-scoped slug, set back to NULL so it
    // looks exactly like a row that predates this migration.
    const created = await createEventType(db, accountId, null, {
      slug: `pg-copy-forward-${Date.now()}`,
      title: 'PG copy-forward',
      lengthMinutes: 30,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;
    // jsonb round-trip: what went in comes back as a JS array, not a string.
    expect(parseEventReminders(
      (await db.get<{ reminders: unknown }>(sql`SELECT reminders FROM event_type WHERE id = ${id}`))!.reminders,
    )).toEqual(defaultEventReminders());

    await db.run(sql`UPDATE event_type SET reminders = NULL WHERE id = ${id}`);
    await upsertNotificationSetting(db, accountId, 'attendee_reminder', {
      reminderLeadMinutes: [4320, 45],
      subject: 'PG: {{event_title}}',
    });

    await applyReminderCopyForward(db);

    const rows = parseEventReminders(
      (await db.get<{ reminders: unknown }>(sql`SELECT reminders FROM event_type WHERE id = ${id}`))!.reminders,
    )!;
    const reminders = rows.filter((r) => r.kind === 'reminder');
    expect(reminders.map((r) => r.leadMinutes)).toEqual([4320, 45]);
    expect(reminders.every((r) => r.subject === 'PG: {{event_title}}')).toBe(true);
    expect(rows.find((r) => r.kind === 'follow_up')!.enabled).toBe(false);

    // Idempotent on Postgres too: a host's later edit survives a second run.
    await updateEventType(db, accountId, id, {
      reminders: [{ id: 'mine', kind: 'reminder', enabled: true, leadMinutes: 15, subject: null, body: null }],
    });
    await applyReminderCopyForward(db);
    const after = parseEventReminders(
      (await db.get<{ reminders: unknown }>(sql`SELECT reminders FROM event_type WHERE id = ${id}`))!.reminders,
    )!;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('mine');

    // An EMPTY list must survive the jsonb round-trip as empty, not as NULL —
    // that is what keeps "deliberately none" distinct from "never configured".
    await updateEventType(db, accountId, id, { reminders: [] });
    expect(parseEventReminders(
      (await db.get<{ reminders: unknown }>(sql`SELECT reminders FROM event_type WHERE id = ${id}`))!.reminders,
    )).toEqual([]);
  });
});
