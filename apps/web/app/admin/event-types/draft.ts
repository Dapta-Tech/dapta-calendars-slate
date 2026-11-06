/**
 * The event-type editor's draft: every value the host can edit, in one object.
 *
 * The editor keeps it in one reducer so its tabs can share it, read it and
 * never lose it, and the save is a pure function of it (`toPayload`), which is
 * what pins "an unchanged event saves exactly what it already has" in a test.
 * Pure TypeScript, no React: the reducer, the initial draft and the payload
 * are all testable on their own.
 */
import { sourceExists } from '@slate/crm/mapping';
import {
  defaultEventReminders,
  normalizeEventTracking,
  type CrmPropertyMapping,
  type EventReminder,
  type LocationKind,
  type SuccessRedirectData,
} from '@slate/types';
import type { Connection, EventType } from '@/lib/admin-api';
import type { EventTypePayload } from './actions';
import {
  SCHEDULING_METHODS,
  type HostRow,
  type IntakeField,
  type SchedulingMethod,
  type TeamMemberOption,
} from './sections/shared';
import { trackingDraftOf, type TrackingDraft } from './sections/tracking';

export interface EventTypeDraft {
  title: string;
  slug: string;
  /** The host typed the slug: titles stop rewriting it. */
  slugTouched: boolean;
  description: string;
  /** '' is "not specified" — the same absent value the column always had. */
  locationKind: LocationKind | '';
  locationDetail: string;
  lengthMinutes: number;
  minNotice: number;
  /** '' is "no limit". */
  windowDays: number | '';
  slotInterval: number | '';
  beforeBuf: number;
  afterBuf: number;
  seats: number | '';
  /** '' is "the host's working hours". */
  scheduleId: string;
  requiresConfirmation: boolean;
  preventDuplicateBookings: boolean;
  hidden: boolean;
  /** '' is "none". */
  redirectUrl: string;
  redirectData: SuccessRedirectData | '';
  trackingDraft: TrackingDraft;
  reminders: EventReminder[];
  fields: IntakeField[];
  /** The wired CRM's mappings, as a flat list; re-keyed by provider on save. */
  crmMappings: CrmPropertyMapping[];
  conflictIds: Set<string>;
  destinationId: string | null;
  schedulingType: SchedulingMethod;
  rrDistribution: 'availability' | 'equal';
  hosts: HostRow[];
}

export interface DraftContext {
  initial?: EventType;
  /** The wired CRM, or null when none is. */
  crmProvider: string | null;
  teamMembers?: TeamMemberOption[];
  connections?: Connection[];
}

/** The draft an editor opens on: the saved event, or the defaults of a new one. */
export function initialDraft({ initial, crmProvider, teamMembers, connections }: DraftContext): EventTypeDraft {
  return {
    title: initial?.title ?? '',
    slug: initial?.slug ?? '',
    slugTouched: !!initial,
    description: initial?.description ?? '',
    locationKind: initial?.location?.kind ?? '',
    locationDetail: initial?.location?.detail ?? '',
    lengthMinutes: initial?.lengthMinutes ?? 30,
    // Hydrate from the stored event — these used to default silently, so EDITING
    // an event reset its notice/interval/buffers on save (QA2 fix 2).
    minNotice: initial?.minimumBookingNotice ?? 120,
    // Booking window, hydrated for the same reason: '' is "no limit", which is
    // what every event that predates it reads as.
    windowDays: initial?.bookingWindowDays ?? '',
    slotInterval: initial?.slotInterval ?? initial?.lengthMinutes ?? 30,
    beforeBuf: initial?.beforeEventBuffer ?? 0,
    afterBuf: initial?.afterEventBuffer ?? 0,
    seats: initial?.seatsPerTimeSlot ?? '',
    scheduleId: initial?.scheduleId ?? '',
    requiresConfirmation: initial?.requiresConfirmation ?? false,
    // Duplicate-booking guard (#69). Hydrated from the event so that EDITING one
    // cannot silently switch it back off. A new event starts off, which is also
    // what every event that predates this reads as.
    preventDuplicateBookings: initial?.preventDuplicateBookings ?? false,
    hidden: initial?.hidden ?? false,
    redirectUrl: initial?.successRedirectUrl ?? '',
    redirectData: initial?.successRedirectData ?? '',
    trackingDraft: trackingDraftOf(initial?.tracking),
    // Reminders + follow-up (#68). Editing opens on the effective list the API
    // returns (a never-configured event surfaces the shipped 24h + 1h with the
    // follow-up off). CREATE seeds the same shipped list — the form both shows
    // what the new event will send and submits it, instead of displaying "no
    // reminders" and then storing that empty list as a deliberate "none".
    reminders: initial?.reminders ?? defaultEventReminders(),
    fields:
      (initial?.bookingFields as IntakeField[] | undefined)?.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: !!f.required,
        defaultCountry: f.defaultCountry,
        options: f.options,
      })) ?? [],
    crmMappings: crmProvider ? (initial?.crmPropertyMappings?.[crmProvider] ?? []) : [],
    // PHASE 2 — per-event calendar selection (personal events only). Prefill
    // from the event's own configured set when non-empty; otherwise default to
    // the host's CURRENT member-level settings (all check_conflicts calendars +
    // the member's is_destination calendar) — identical to today's behavior.
    conflictIds: new Set(
      initial?.conflictCalendarIds && initial.conflictCalendarIds.length > 0
        ? initial.conflictCalendarIds
        : (connections ?? []).filter((c) => c.checkConflicts).map((c) => c.id),
    ),
    destinationId: initial?.destinationCalendarId ?? (connections ?? []).find((c) => c.isDestination)?.id ?? null,
    schedulingType: (SCHEDULING_METHODS as readonly string[]).includes(initial?.schedulingType ?? '')
      ? (initial!.schedulingType as SchedulingMethod)
      : 'round_robin',
    // 'availability' (null in the column) is today's behavior, 'equal' counts
    // this event's bookings only.
    rrDistribution: initial?.rrDistribution === 'equal' ? 'equal' : 'availability',
    hosts: (teamMembers ?? []).map((tm) => {
      const existing = initial?.hosts?.find((h) => h.memberId === tm.memberId);
      return {
        memberId: tm.memberId,
        priority: existing?.priority ?? 0,
        weight: existing?.weight ?? 100,
        isFixed: existing?.isFixed ?? false,
      };
    }),
  };
}

/** One field of the draft, set to a value or by an updater of its current value. */
export type DraftAction = {
  [K in keyof EventTypeDraft]: {
    type: 'set';
    key: K;
    value: EventTypeDraft[K] | ((prev: EventTypeDraft[K]) => EventTypeDraft[K]);
  };
}[keyof EventTypeDraft];

export function draftReducer(state: EventTypeDraft, action: DraftAction): EventTypeDraft {
  const prev = state[action.key];
  const next =
    typeof action.value === 'function'
      ? (action.value as (p: typeof prev) => typeof prev)(prev)
      : action.value;
  return Object.is(prev, next) ? state : { ...state, [action.key]: next };
}

export interface PayloadContext {
  initial?: EventType;
  crmProvider: string | null;
  /** The Tracking section is shown: only then does the save carry `tracking`. */
  trackingEnabled: boolean;
  isTeamEvent: boolean;
  /** The team a NEW team event is created for. */
  teamId?: string;
  /** The host's connections were loaded (personal events): the save carries
   *  the per-event calendar choice. */
  hasConnections: boolean;
}

/**
 * What the save sends for a draft. Moved verbatim from the editor's `save()`;
 * `draft.spec.ts` pins that an unchanged event sends what it already has.
 */
export function toPayload(d: EventTypeDraft, ctx: PayloadContext): EventTypePayload {
  const { initial, crmProvider, trackingEnabled, isTeamEvent, teamId, hasConnections } = ctx;
  const redirectTrimmed = d.redirectUrl.trim();
  return {
    id: initial?.id,
    title: d.title,
    slug: d.slug,
    description: d.description.trim() || null,
    location: d.locationKind
      ? {
          kind: d.locationKind,
          // Conferencing has no host-authored detail — the link is minted
          // by the calendar port at write-out.
          detail: d.locationKind === 'conferencing' ? null : d.locationDetail.trim() || null,
        }
      : null,
    lengthMinutes: Number(d.lengthMinutes),
    minimumBookingNotice: Number(d.minNotice),
    bookingWindowDays: d.windowDays === '' ? null : Number(d.windowDays),
    slotInterval: d.slotInterval === '' ? null : Number(d.slotInterval),
    beforeEventBuffer: Number(d.beforeBuf),
    afterEventBuffer: Number(d.afterBuf),
    seatsPerTimeSlot: d.seats === '' ? null : Number(d.seats),
    scheduleId: d.scheduleId || null,
    requiresConfirmation: d.requiresConfirmation,
    // Travels on create AND edit, personal AND team events — both public
    // write paths honour it, so the editor must not offer it on only one.
    preventDuplicateBookings: d.preventDuplicateBookings,
    hidden: d.hidden,
    bookingFields: d.fields.filter((f) => f.name && f.label),
    reminders: d.reminders,
    successRedirectUrl: redirectTrimmed || null,
    // Nothing to carry without an address: cleared with it.
    successRedirectData: redirectTrimmed && d.redirectData ? d.redirectData : null,
    // Blank ids are left out, and nothing left is null ("no tracking").
    ...(trackingEnabled ? { tracking: normalizeEventTracking(d.trackingDraft) } : {}),
    // Re-keyed by provider, and only sent when an adapter is wired: a
    // deployment with no CRM must not rewrite this column at all, so an
    // event configured on a CRM-enabled deployment keeps its mappings if it
    // is later edited on one where the CRM is off.
    ...(crmProvider
      ? {
          crmPropertyMappings: {
            // Other providers' mappings are preserved verbatim — this
            // editor only ever owns the wired one's list.
            ...(initial?.crmPropertyMappings ?? {}),
            [crmProvider]: deliverableMappings(d.crmMappings, d.fields),
          },
        }
      : {}),
    ...(isTeamEvent
      ? {
          // teamId travels on CREATE only — an existing event never
          // changes teams from this form.
          ...(initial ? {} : { teamId }),
          schedulingType: d.schedulingType,
          rrDistribution: d.rrDistribution === 'equal' ? 'equal' : null,
          hosts: d.hosts.map((h) => ({
            memberId: h.memberId,
            priority: h.priority,
            weight: h.weight,
            isFixed: d.schedulingType === 'fixed_round_robin' ? h.isFixed : false,
          })),
        }
      : hasConnections
        ? {
            // PHASE 2 — personal events only; team events send no calendar
            // config (the API ignores it for team events regardless).
            conflictCalendarIds: [...d.conflictIds],
            destinationCalendarId: d.destinationId,
          }
        : {}),
  };
}

/**
 * The mapping rows a save may actually carry.
 *
 * Two kinds of row are dropped rather than sent, because sending either one
 * makes the WHOLE event type unsaveable:
 *
 *   - a row with an unchosen target. "+ Add another property" appends an empty
 *     slot, and the contract requires every target to be a non-empty string —
 *     so an untouched slot would 400 the save, taking the title, the questions
 *     and the reminders down with it.
 *   - a row whose QUESTION no longer exists. Deleting, renaming or retyping an
 *     intake question orphans its mapping; the row is flagged in the section so
 *     the host sees it going, and it must not block an ordinary edit.
 */
export function deliverableMappings(
  rows: CrmPropertyMapping[],
  fields: IntakeField[],
): CrmPropertyMapping[] {
  return rows
    .filter((row) => sourceExists(row.source, fields))
    .map((row) => ({ ...row, properties: row.properties.filter((p) => p.trim() !== '') }))
    .filter((row) => row.properties.length > 0);
}
