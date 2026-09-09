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
 * This module is pure storage; it deliberately does NOT
 * know the shipped template COPY (that lives in @slate/notifications, the
 * rendering side) — a reminder with a NULL subject/body resolves to the shipped
 * template in the host's locale at enqueue time.
 */
import { sql } from 'drizzle-orm';
import {
  DEFAULT_FOLLOW_UP_LEAD_MINUTES,
  DEFAULT_REMINDER_LEAD_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  MAX_REMINDER_LEAD_MINUTES,
  MIN_REMINDER_LEAD_MINUTES,
  defaultEventReminders,
  type EventReminder,
} from '@slate/types';
import type { Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';

// The caps, the lead bounds and the shipped list live in the CONTRACT package
// so the API, the storage and the editor cannot disagree about them — a cap
// the API enforces and the storage silently truncates differently is a bug
// nothing fails on. Re-exported here because this module is where the rest of
// the codebase already reaches for reminder storage.
export {
  DEFAULT_FOLLOW_UP_LEAD_MINUTES,
  DEFAULT_REMINDER_LEAD_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  MAX_REMINDER_LEAD_MINUTES,
  MIN_REMINDER_LEAD_MINUTES,
  defaultEventReminders,
};
export type { EventReminder };
export type EventReminderKind = EventReminder['kind'];

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
  const pending = await db.all<{ account_id: string }>(
    sql`SELECT DISTINCT account_id FROM event_type WHERE reminders IS NULL`,
  );
  if (pending.length === 0) return;

  for (const { account_id: accountId } of pending) {
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
    const source: AccountReminderSource = {
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
    };
    // Every event type of one account inherits the SAME list, so this is one
    // statement per account rather than one per event type — the fixup runs in
    // the boot path, before the API listens.
    await db.run(
      sql`UPDATE event_type SET reminders = ${jsonParam(db, remindersFromAccount(source))}
          WHERE account_id = ${accountId} AND reminders IS NULL`,
    );
  }
}
