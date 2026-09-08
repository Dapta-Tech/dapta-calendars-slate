/**
 * PER-EVENT-TYPE REMINDERS — the storage behind the event editor's Reminders
 * section (#68 / #91). A reminder is owned by the event type, not the account:
 * each one has its own switch, lead time, subject and body.
 *
 * The list lives as JSON on `event_type.reminders` (jsonb on Postgres, text on
 * SQLite) rather than in a table of its own — it is an ordered list, owned by
 * one event type, always read whole and never queried across events, exactly
 * like `booking_fields` beside it.
 *
 * Three states, and the first two are deliberately different:
 *   NULL   never configured  → `effectiveReminders` substitutes the shipped
 *                              defaults (24h + 1h on, follow-up off)
 *   []     deliberately none → nothing is scheduled
 *   [...]  exactly these
 * Collapsing NULL and [] would hand a host back the reminder they just deleted.
 *
 * This module is pure storage plus its own defaults; it deliberately does NOT
 * know the shipped template COPY (that lives in @slate/notifications, the
 * rendering side) — a reminder with a NULL subject/body resolves to the shipped
 * template in the host's locale at enqueue time.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';

/** At most this many `reminder` rows on one event type (#68 decision 7). */
export const MAX_REMINDERS_PER_EVENT = 10;
/** Lead bounds, inherited from the account screen this replaces. */
export const MIN_REMINDER_LEAD_MINUTES = 5;
export const MAX_REMINDER_LEAD_MINUTES = 28 * 24 * 60;

/** Shipped reminder leads on a NEW event type: 24h and 1h, both on (#68 d4). */
export const DEFAULT_REMINDER_LEAD_MINUTES = [24 * 60, 60];
/** Shipped follow-up lead: 1h after the meeting ends — and OFF (#68 d5). */
export const DEFAULT_FOLLOW_UP_LEAD_MINUTES = 60;

export type EventReminderKind = 'reminder' | 'follow_up';

export interface EventReminder {
  /** Unique WITHIN this event type's list — what the deliver-time gate reads. */
  id: string;
  /** `reminder` fires BEFORE start; `follow_up` fires AFTER the end. */
  kind: EventReminderKind;
  enabled: boolean;
  leadMinutes: number;
  /** NULL = the shipped default template, resolved in the host's locale. */
  subject: string | null;
  body: string | null;
}

/** What a brand-new event type is born with: 24h + 1h on, follow-up off. */
export function defaultEventReminders(): EventReminder[] {
  return [
    ...DEFAULT_REMINDER_LEAD_MINUTES.map((leadMinutes, i) => ({
      id: `r${i + 1}`,
      kind: 'reminder' as const,
      enabled: true,
      leadMinutes,
      subject: null,
      body: null,
    })),
    {
      id: 'f1',
      kind: 'follow_up' as const,
      enabled: false,
      leadMinutes: DEFAULT_FOLLOW_UP_LEAD_MINUTES,
      subject: null,
      body: null,
    },
  ];
}

function coerceRow(raw: unknown, index: number): EventReminder | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'follow_up' ? 'follow_up' : 'reminder';
  const lead = Number(r.leadMinutes);
  if (!Number.isFinite(lead) || lead < MIN_REMINDER_LEAD_MINUTES || lead > MAX_REMINDER_LEAD_MINUTES)
    return null;
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : `${kind === 'follow_up' ? 'f' : 'r'}${index + 1}`;
  return {
    id,
    kind,
    enabled: r.enabled !== false,
    leadMinutes: Math.trunc(lead),
    subject: typeof r.subject === 'string' && r.subject.length > 0 ? r.subject : null,
    body: typeof r.body === 'string' && r.body.length > 0 ? r.body : null,
  };
}

/**
 * Parse the stored column. `null` means "never configured" and is preserved as
 * `null` — the caller decides whether that means shipped defaults. Unparseable
 * JSON, a non-array, or rows with an out-of-range lead are dropped rather than
 * thrown: a malformed column must never break a booking's mail.
 */
export function parseEventReminders(raw: unknown): EventReminder[] | null {
  if (raw == null || raw === '') return null;
  const arr = parseJsonColumn<unknown>(raw, null);
  if (!Array.isArray(arr)) return null;
  const rows = arr.map(coerceRow).filter((r): r is EventReminder => r !== null);
  // Dedupe ids so the deliver-time gate can never match two rows.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** The list a booking actually schedules from: NULL ⇒ the shipped defaults. */
export function effectiveReminders(parsed: EventReminder[] | null): EventReminder[] {
  return parsed ?? defaultEventReminders();
}

/** Cap + shape guard applied on every write (the API validates too). */
export function normalizeEventReminders(rows: EventReminder[]): EventReminder[] {
  const reminders = rows.filter((r) => r.kind === 'reminder').slice(0, MAX_REMINDERS_PER_EVENT);
  const followUp = rows.filter((r) => r.kind === 'follow_up').slice(0, 1);
  return [...reminders, ...followUp];
}

/* ------------------------------------------------------------------------ *
 * Copy-forward (#68 decision 9)                                            *
 * ------------------------------------------------------------------------ */

interface AccountReminderSource {
  leads: number[];
  enabled: boolean;
  subject: string | null;
  body: string | null;
  followUpLead: number;
  followUpEnabled: boolean;
  followUpSubject: string | null;
  followUpBody: string | null;
}

function parseLeads(raw: unknown, fallback: number[]): number[] {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return fallback;
    const leads = arr
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= MIN_REMINDER_LEAD_MINUTES && n <= MAX_REMINDER_LEAD_MINUTES)
      .map((n) => Math.trunc(n));
    return leads.length > 0 ? leads : fallback;
  } catch {
    return fallback;
  }
}

function remindersFromAccount(src: AccountReminderSource): EventReminder[] {
  return normalizeEventReminders([
    ...src.leads.map((leadMinutes, i) => ({
      id: `r${i + 1}`,
      kind: 'reminder' as const,
      enabled: src.enabled,
      leadMinutes,
      subject: src.subject,
      body: src.body,
    })),
    {
      id: 'f1',
      kind: 'follow_up' as const,
      enabled: src.followUpEnabled,
      leadMinutes: src.followUpLead,
      subject: src.followUpSubject,
      body: src.followUpBody,
    },
  ]);
}

/**
 * Give every event type that has none a copy of its ACCOUNT's current reminder
 * configuration, so an existing host keeps receiving exactly the mail they
 * receive today, at the times they already chose, and opens the new editor
 * pre-populated rather than empty (#68 decision 9).
 *
 * Runs from migrate.ts beside `applyShortLinkFixups`: building a JSON array out
 * of another table's JSON array is jsonb_agg-over-lateral-unnest on one engine
 * and json_group_array/json_each on the other — one TypeScript pass is both
 * safer and the only version that gets exercised on both dialects.
 *
 * Idempotent by construction: it only touches rows WHERE reminders IS NULL, so
 * a second run is a cheap no-op and a host's later edits are never overwritten.
 */
export async function applyReminderCopyForward(db: Db): Promise<void> {
  const pending = await db.all<{ id: string; account_id: string }>(
    sql`SELECT id, account_id FROM event_type WHERE reminders IS NULL`,
  );
  if (pending.length === 0) return;

  const accountIds = [...new Set(pending.map((r) => r.account_id))];
  const sources = new Map<string, AccountReminderSource>();
  for (const accountId of accountIds) {
    const rows = await db.all<{
      email_key: string;
      enabled: number;
      subject: string | null;
      body: string | null;
      reminder_lead_minutes: unknown;
    }>(
      sql`SELECT email_key, enabled, subject, body, reminder_lead_minutes
          FROM notification_setting
          WHERE account_id = ${accountId}
            AND email_key IN ('attendee_reminder', 'follow_up')`,
    );
    const reminder = rows.find((r) => r.email_key === 'attendee_reminder');
    const followUp = rows.find((r) => r.email_key === 'follow_up');
    sources.set(accountId, {
      // An ABSENT row means the account was on the shipped defaults — the same
      // fallback the enqueue path used before this change.
      leads: parseLeads(reminder?.reminder_lead_minutes, DEFAULT_REMINDER_LEAD_MINUTES),
      enabled: reminder ? Number(reminder.enabled) !== 0 : true,
      subject: reminder?.subject ?? null,
      body: reminder?.body ?? null,
      followUpLead: parseLeads(followUp?.reminder_lead_minutes, [DEFAULT_FOLLOW_UP_LEAD_MINUTES])[0]!,
      // follow_up is opt-in: absent = OFF, matching defaultEnabledFor().
      followUpEnabled: followUp ? Number(followUp.enabled) !== 0 : false,
      followUpSubject: followUp?.subject ?? null,
      followUpBody: followUp?.body ?? null,
    });
  }

  for (const row of pending) {
    const src = sources.get(row.account_id);
    if (!src) continue;
    await db.run(
      sql`UPDATE event_type SET reminders = ${jsonParam(db, remindersFromAccount(src))}
          WHERE id = ${row.id} AND reminders IS NULL`,
    );
  }
}
