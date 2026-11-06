/**
 * One validation model for the event-type editor. `validateDraft` returns every
 * problem with WHERE it is (the field's DOM id, its tab, and the collapsed
 * section holding it), and that one list drives everything the host sees:
 * the message under the field, the count on each tab, the summary at the top,
 * and the save's jump to the first error.
 *
 * Pure: no React, no DOM. The checks mirror what the API refuses, so the host
 * learns it beside the field instead of from a failed save.
 */
import { isReservedFieldName } from '@slate/shared';
import { MAX_BOOKING_WINDOW_DAYS, isSuccessRedirectUrl as isRedirectUrl } from '@slate/types';
import type { EventTypeDraft } from './draft';
import type { EventTypeMessages } from './sections/shared';
import { invalidTrackingKeys, type TrackingKey } from './sections/tracking';

export const EDITOR_TABS = ['general', 'reminders', 'crm', 'agents'] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

/** A collapsed part of a tab that must open before its field can be focused. */
export type EditorSection = 'advanced';

export interface FieldError {
  /** The DOM id of the control to focus. */
  fieldId: string;
  tab: EditorTab;
  section?: EditorSection;
  message: string;
}

/** Stable DOM ids for every control an error can point at. */
export const FIELD_IDS = {
  title: 'et-title',
  slug: 'et-slug',
  duration: 'et-duration',
  locationDetail: 'et-location-detail',
  minNotice: 'et-min-notice',
  beforeBuf: 'et-buffer-before',
  afterBuf: 'et-buffer-after',
  seats: 'et-seats',
  windowDays: 'et-booking-window',
  slotInterval: 'et-slot-interval',
  redirectUrl: 'et-redirect-url',
  tracking: (key: TrackingKey) => `et-tracking-${key}`,
  questionName: (i: number) => `et-question-${i}-name`,
  reminder: (id: string, field: 'subject' | 'body') => `et-reminder-${id}-${field}`,
} as const;

/** Most minutes one event may last (the API's cap). */
export const MAX_LENGTH_MINUTES = 1440;

const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export interface ValidateContext {
  m: EventTypeMessages;
  /** Tracking is shown (and saved) for this workspace. */
  trackingEnabled: boolean;
  trackingKeys: TrackingKey[];
}

/** Every problem in the draft, in tab order and, within a tab, in form order. */
export function validateDraft(d: EventTypeDraft, { m, trackingEnabled, trackingKeys }: ValidateContext): FieldError[] {
  const e = m.editor.errors;
  const out: FieldError[] = [];
  const general = (fieldId: string, message: string, section?: EditorSection) =>
    out.push({ fieldId, tab: 'general', message, ...(section ? { section } : {}) });

  // Basics
  if (!d.title.trim()) general(FIELD_IDS.title, e.titleRequired);
  if (!d.slug.trim()) general(FIELD_IDS.slug, e.slugRequired);
  if (!isWhole(d.lengthMinutes) || d.lengthMinutes < 1 || d.lengthMinutes > MAX_LENGTH_MINUTES)
    general(FIELD_IDS.duration, e.durationInvalid);
  if (d.locationKind && d.locationKind !== 'conferencing' && !d.locationDetail.trim())
    general(FIELD_IDS.locationDetail, e.locationDetailRequired);

  // Availability
  if (!isWhole(d.minNotice) || d.minNotice < 0) general(FIELD_IDS.minNotice, e.minNoticeInvalid);

  // Booking form: a reserved name would make the public page ask twice.
  d.fields.forEach((f, i) => {
    if (f.name && isReservedFieldName(f.name)) general(FIELD_IDS.questionName(i), m.reservedWarning);
  });

  // After booking
  const redirect = d.redirectUrl.trim();
  if (redirect && !isRedirectUrl(redirect)) general(FIELD_IDS.redirectUrl, m.successRedirect.invalid);

  // Advanced settings
  if (!isWhole(d.beforeBuf) || d.beforeBuf < 0) general(FIELD_IDS.beforeBuf, e.bufferInvalid, 'advanced');
  if (!isWhole(d.afterBuf) || d.afterBuf < 0) general(FIELD_IDS.afterBuf, e.bufferInvalid, 'advanced');
  if (d.seats !== '' && (!isWhole(d.seats) || d.seats < 1)) general(FIELD_IDS.seats, e.seatsInvalid, 'advanced');
  if (d.windowDays !== '' && (!isWhole(d.windowDays) || d.windowDays < 1 || d.windowDays > MAX_BOOKING_WINDOW_DAYS))
    general(
      FIELD_IDS.windowDays,
      m.bookingWindow.invalid.replace('{max}', String(MAX_BOOKING_WINDOW_DAYS)),
      'advanced',
    );
  if (d.slotInterval !== '' && (!isWhole(d.slotInterval) || d.slotInterval < 1))
    general(FIELD_IDS.slotInterval, e.intervalInvalid, 'advanced');

  // CRM Connection: tracking ids
  if (trackingEnabled) {
    for (const key of invalidTrackingKeys(d.trackingDraft, trackingKeys)) {
      out.push({ fieldId: FIELD_IDS.tracking(key), tab: 'crm', message: e.trackingInvalid });
    }
  }

  return out;
}

/** Errors per tab, for the badges. */
export function errorCounts(errors: readonly FieldError[]): Record<EditorTab, number> {
  const counts: Record<EditorTab, number> = { general: 0, reminders: 0, crm: 0, agents: 0 };
  for (const err of errors) counts[err.tab] += 1;
  return counts;
}

/** The first error in tab order: where a failed save takes the host. */
export function firstError(errors: readonly FieldError[]): FieldError | undefined {
  return [...errors].sort((a, b) => EDITOR_TABS.indexOf(a.tab) - EDITOR_TABS.indexOf(b.tab))[0];
}
