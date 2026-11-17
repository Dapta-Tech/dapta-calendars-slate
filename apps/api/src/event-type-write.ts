import { BadRequestException } from '@nestjs/common';
import {
  createEventType,
  getMe,
  isUsableSchedule,
  sql,
  updateEventType,
  type CrudResult,
  type Db,
  type EventTypeView,
} from '@slate/db';
import {
  EVENT_TRACKING_HOST_SCRIPT_KEYS,
  bookingMinutesLimitProblem,
  normalizeEventTracking,
  type CrmPropertyMappings,
  type EventTracking,
  type EventTypeInput,
} from '@slate/types';
import type { ServerEnv } from '@slate/config/env';
import { isCompatible, sourceExists, type MappableField } from '@slate/crm/mapping';
import type { CrmPropertyCatalogService } from './crm-property-catalog';
import { trackingAllowedFor } from './event-tracking-gate';
import { assertAdmin, assertOwnsOrAdmin, type RoledPrincipal } from './permissions';
import { assertCalendarTemplates, assertReminderTemplates } from './template-validation';

/**
 * The one way an event type is created or changed: the checks a save must
 * pass, then the write. The dashboard routes (`POST` and `PATCH
 * /v1/event-types`) and the MCP tools (`create_event_type`,
 * `update_event_type`) both come through here, so an agent's edit meets every
 * rule a person's does. Refusals are the HTTP exceptions the dashboard has
 * always answered; the MCP maps them to tool errors.
 *
 * Who is writing is the caller's to decide (the dashboard's signed-in member,
 * the member an OAuth connection acts as, the owner an API key acts for); the
 * caller also fires the publish analytics, because only it knows the source.
 */
export interface EventTypeWriteDeps {
  db: Db;
  /** The CRM's property schema, for the save-time compatibility check. Absent: the check is skipped. */
  crmProperties?: Pick<CrmPropertyCatalogService, 'catalog'> | null;
  /** EVENT_TRACKING_ACCOUNTS. Absent: no workspace may set GTM, GA4 or HubSpot, the env's default. */
  env?: Pick<ServerEnv, 'EVENT_TRACKING_ACCOUNTS' | 'PUBLIC_APP_URL' | 'PUBLIC_BOOKING_URL'>;
}

/** Who writes: a member of the account, with the role that decides what they may touch. */
export type EventTypeWriter = RoledPrincipal & { accountId: string };

/** Refuse a minutes limit shorter than the event, as the event stands after the save. */
function assertMinutesLimitsFit(e: Parameters<typeof bookingMinutesLimitProblem>[0]): void {
  const problem = bookingMinutesLimitProblem(e);
  if (problem) throw new BadRequestException({ error: 'BAD_REQUEST', message: problem });
}

/**
 * The availability rules a save must keep (custom hours; see
 * `packages/db/src/event-custom-hours.ts`): custom hours replace a schedule, so
 * a save names one or the other; they exist for personal events only (team
 * hosts follow their own schedules); and a schedule an event follows must be a
 * reusable one of the same account and, for a personal event, of its own host
 * (never another account's, another member's, or an event's private hours).
 */
async function assertAvailabilitySource(
  db: Db,
  input: { customHours?: unknown; scheduleId?: string | null },
  owner: { accountId: string; memberId: string | null },
  isTeam: boolean,
): Promise<void> {
  if (input.customHours && input.scheduleId !== undefined) {
    throw new BadRequestException({
      error: 'BAD_REQUEST',
      message: 'Send customHours or scheduleId, not both.',
    });
  }
  if (input.customHours && isTeam) {
    throw new BadRequestException({
      error: 'BAD_REQUEST',
      message: 'Custom hours are for personal event types; team hosts follow their own schedules.',
    });
  }
  if (
    input.scheduleId &&
    !(await isUsableSchedule(db, { accountId: owner.accountId, scheduleId: input.scheduleId, memberId: owner.memberId }))
  ) {
    throw new BadRequestException({ error: 'BAD_REQUEST', message: 'That schedule cannot be used.' });
  }
}

/**
 * Tracking and pixels change only by an owner or admin. Meta Pixel and
 * PostHog ids need nothing more: they load only vendor code. A Google Tag
 * Manager container, GA4 property or HubSpot portal can run code set up in
 * the host's own account on the dashboard's origin, so setting or changing
 * one also needs a workspace the deployment allows (`trackingAllowedFor`). A save that leaves the ids as
 * they are (every editor save sends them) passes untouched, so a member can
 * still edit their event. Clearing any id needs an owner or admin, but never
 * the deployment's permission.
 */
async function assertTrackingChange(
  deps: EventTypeWriteDeps,
  p: EventTypeWriter,
  next: EventTracking | null | undefined,
  current: EventTracking | null,
): Promise<void> {
  if (next === undefined) return;
  const normalized = normalizeEventTracking(next);
  const before = normalizeEventTracking(current);
  if (JSON.stringify(normalized) === JSON.stringify(before)) return;
  assertAdmin(p);
  // Only a NEW or changed GTM container, GA4 property or HubSpot portal
  // needs the deployment's permission: those can run the host's own code.
  // Every other id, and clearing any id, needs none.
  const newScripts = EVENT_TRACKING_HOST_SCRIPT_KEYS.some((key) => normalized?.[key] && normalized[key] !== before?.[key]);
  if (!newScripts) return;
  const account = await deps.db.get<{ code: string; vanity_slug: string | null }>(
    sql`SELECT code, vanity_slug FROM account WHERE id = ${p.accountId} LIMIT 1`,
  );
  if (!account || !trackingAllowedFor(deps.env, { code: account.code, vanitySlug: account.vanity_slug })) {
    throw new BadRequestException({
      error: 'TRACKING_DISABLED',
      message: 'Google Tag Manager, Google Analytics and HubSpot are not enabled for this workspace on this deployment.',
    });
  }
}

/** The language the host reads template errors in (their own UI locale). */
async function hostLocale(db: Db, p: { accountId: string; memberId: string }): Promise<'en' | 'es'> {
  const me = await getMe(db, p.accountId, p.memberId);
  return me?.locale === 'es' ? 'es' : 'en';
}

/**
 * Refuse a mapping this portal could not deliver (#64).
 *
 * The picker already filters to compatible properties, so reaching this needs
 * a hand-written request or a stale editor — but "unreachable beats
 * diagnosable" is the whole reason #64 put a check on the server too. Without
 * it an incompatible pair saves cleanly and then silently delivers nothing,
 * one booking at a time, in an outbox nobody watches.
 *
 * Three cases are deliberately ALLOWED rather than refused, all for the same
 * reason: none of them is a pair that would deliver WRONGLY, and refusing any
 * of them blocks an edit that has nothing to do with the CRM.
 *
 *   - a mapping whose QUESTION is gone. Deleting, renaming or retyping an
 *     intake question orphans its mapping, and that is an ordinary edit — the
 *     one thing it must not do is make the event type unsaveable. The editor
 *     flags the row and drops it from the payload; here it is simply skipped.
 *   - a property the portal does not have. That is the broken-mapping state
 *     the editor already draws in red, and refusing it would make an
 *     unrelated edit unsaveable because somebody deleted a property in the CRM.
 *   - no reachable catalog at all (CRM off, nothing connected, portal down).
 *     Blocking an event-type save because the CRM is briefly unreachable is a
 *     far worse trade than accepting a mapping the picker already filtered.
 */
export async function assertMappingsAreDeliverable(
  deps: EventTypeWriteDeps,
  accountId: string,
  mappings: CrmPropertyMappings | null | undefined,
  fields: readonly MappableField[],
): Promise<void> {
  if (!mappings || !deps.crmProperties) return;
  const rows = Object.values(mappings).flat();
  if (rows.length === 0) return;

  const catalog = await deps.crmProperties.catalog(accountId);
  if (!catalog.connected || catalog.properties.length === 0) return;
  const byName = new Map(catalog.properties.map((p) => [p.name.toLowerCase(), p]));

  for (const row of rows) {
    // An ORPHANED source is not an incompatible one. `isCompatible` cannot
    // tell them apart — it returns false for both — so the distinction has
    // to be drawn here, before the refusal.
    if (!sourceExists(row.source, fields)) continue;
    for (const target of row.properties) {
      const property = byName.get(target.toLowerCase());
      if (!property) continue;
      if (isCompatible(row.source, property, fields)) continue;
      throw new BadRequestException({
        error: 'CRM_MAPPING_INCOMPATIBLE',
        message: `${target} cannot receive this answer: the property's type does not match the answer's.`,
      });
    }
  }
}

/** A new event type, owned by the writer (or by a team, which needs an owner or admin). */
export async function createEventTypeChecked(
  deps: EventTypeWriteDeps,
  p: EventTypeWriter,
  input: EventTypeInput,
): Promise<CrudResult<EventTypeView>> {
  // A team event-type is a cross-member resource → admin/owner only. A plain
  // member may only create their OWN personal event-type.
  if (input.teamId) assertAdmin(p);
  assertMinutesLimitsFit(input);
  await assertAvailabilitySource(
    deps.db,
    input,
    { accountId: p.accountId, memberId: input.teamId ? null : p.memberId },
    Boolean(input.teamId),
  );
  await assertTrackingChange(deps, p, input.tracking, null);
  const locale = await hostLocale(deps.db, p);
  if (input.reminders) assertReminderTemplates(input.reminders, [], locale);
  assertCalendarTemplates(input, null, locale);
  await assertMappingsAreDeliverable(deps, p.accountId, input.crmPropertyMappings, (input.bookingFields ?? []) as MappableField[]);
  return createEventType(deps.db, p.accountId, p.memberId, input);
}

/** A change to an event type of the writer's account, which the caller has already looked up. */
export async function updateEventTypeChecked(
  deps: EventTypeWriteDeps,
  p: EventTypeWriter,
  existing: EventTypeView,
  input: Partial<EventTypeInput>,
): Promise<CrudResult<EventTypeView>> {
  assertOwnsOrAdmin(p, existing.memberId);
  // Against what the save leaves: a partial save keeps the stored length and limits.
  assertMinutesLimitsFit({
    lengthMinutes: input.lengthMinutes ?? existing.lengthMinutes,
    maxMinutesPerDay: input.maxMinutesPerDay !== undefined ? input.maxMinutesPerDay : existing.maxMinutesPerDay,
    maxMinutesPerWeek: input.maxMinutesPerWeek !== undefined ? input.maxMinutesPerWeek : existing.maxMinutesPerWeek,
  });
  await assertAvailabilitySource(
    deps.db,
    input,
    { accountId: p.accountId, memberId: existing.teamId ? null : existing.memberId },
    Boolean(existing.teamId),
  );
  await assertTrackingChange(deps, p, input.tracking, existing.tracking);
  const locale = await hostLocale(deps.db, p);
  if (input.reminders) assertReminderTemplates(input.reminders, existing.reminders, locale);
  assertCalendarTemplates(input, existing, locale);
  // Validated against the questions this save LEAVES BEHIND: a partial update
  // that omits `bookingFields` keeps the event's existing ones, and checking
  // against an empty list would refuse every question mapping on such a save.
  await assertMappingsAreDeliverable(
    deps,
    p.accountId,
    input.crmPropertyMappings,
    (input.bookingFields ?? existing.bookingFields ?? []) as MappableField[],
  );
  return updateEventType(deps.db, p.accountId, existing.id, input);
}
