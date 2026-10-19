/**
 * EMAIL TEMPLATES — the editable layer of the notification system.
 *
 * Every booking email renders from a { subject, body } template: the shipped
 * defaults below (EN/ES, per email key) or a per-account override stored in
 * `notification_setting`. Bodies are PLAIN TEXT written in the template
 * language of `@slate/engine` (`{{variable}}`, fallbacks, `{{#if}}` blocks), the
 * same one the calendar event uses. No user-authored HTML ever reaches an email
 * (public-facing hardening E8): rendering escapes both template text and
 * substituted values, and only catalog variables resolve; unknown names render
 * empty.
 *
 * Line rule (keeps optional fields tidy, mirrors the pre-template behavior):
 * a line that contains tokens which ALL resolve empty is dropped — so
 * "Where: {{location}}" vanishes when there is no location, and
 * "{{pending_note}}" only appears for approval-required bookings.
 */
import {
  FORM_VARIABLE_PREFIX,
  formVariable,
  renderTemplate as renderWithEngine,
  templateVariableNames,
  type TemplateLocale,
  type TemplateValue,
} from '@slate/engine';
import { isValidTimeZone } from '@slate/shared';
import type { BookingNotification } from './booking-notifier';
import { escapeHtml } from './util';

export const EMAIL_TEMPLATE_KEYS = [
  'attendee_confirmation',
  'attendee_pending',
  'attendee_declined',
  'attendee_reschedule',
  'attendee_cancellation',
  'attendee_reminder',
  'host_booked',
  'host_rescheduled',
  'host_cancelled',
  'host_declined',
  'host_reminder',
  'follow_up',
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export function isEmailTemplateKey(v: string): v is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(v);
}

/**
 * The keys that MOVED to the event type (#68): reminders and the follow-up are
 * configured per event now, so Settings → Notifications no longer shows or
 * accepts them. They keep their shipped default copy, which is what a reminder
 * with a NULL subject/body renders, and their stored rows survive as the
 * copy-forward source — they are simply no longer editable account-wide.
 */
export const EVENT_LEVEL_TEMPLATE_KEYS = [
  'attendee_reminder',
  'host_reminder',
  'follow_up',
] as const satisfies readonly EmailTemplateKey[];

/** The transactional keys that remain account-wide (one text, every event). */
export const ACCOUNT_TEMPLATE_KEYS = EMAIL_TEMPLATE_KEYS.filter(
  (k) => !(EVENT_LEVEL_TEMPLATE_KEYS as readonly string[]).includes(k),
);

export function isAccountTemplateKey(v: string): v is EmailTemplateKey {
  return isEmailTemplateKey(v) && !(EVENT_LEVEL_TEMPLATE_KEYS as readonly string[]).includes(v);
}

/**
 * Whether a key sends with NO stored setting. Lifecycle mail defaults ON
 * (parity with the pre-toggle product); the post-meeting follow-up is
 * marketing-ish, so it is strictly opt-in.
 */
export function defaultEnabledFor(key: EmailTemplateKey): boolean {
  return key !== 'follow_up';
}

export type { TemplateLocale };

export interface EmailTemplate {
  subject: string;
  body: string;
}

/**
 * The variables an email can use: the `email` half of the engine's catalog
 * (`variablesFor('email')`, which the editor lists), spelled out here so the
 * compiler checks that `templateVars` gives every one of them a value. A spec
 * keeps the two lists equal.
 */
export const TEMPLATE_VARIABLES = [
  'attendee_name',
  'attendee_first_name',
  'attendee_email',
  'attendee_phone',
  'guests',
  'attendee_time_zone',
  'host_name',
  'host_email',
  'event_name',
  'event_title',
  'event_description',
  'duration',
  'location',
  'workspace_name',
  'team_name',
  'start_time',
  'end_time',
  'start_time_host',
  'end_time_host',
  'start_time_attendee',
  'end_time_attendee',
  'time_zone',
  'previous_start_time',
  'reminder_lead',
  // The conferencing link. UNIQUE among these: it is the one variable resolved
  // at DELIVERY time rather than snapshotted at enqueue, because it is minted
  // later by the calendar outbox row (ADR 0007). Empty when the write-out has
  // not produced one, and the empty-line rule then drops its whole line.
  'meeting_url',
  'manage_url',
  'cancel_link',
  'reschedule_link',
  'booking_link',
  'booking_uid',
  'cancellation_reason',
  'pending_note',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * The rendered variable map: every built-in is present as text (the branded
 * layout reads `v.start_time` without a guard), plus an open tail for the
 * `{{form.*}}` namespace, whose names are only known at run time and whose
 * values stay RAW (a yes/no answer stays a boolean and a multi-select a list,
 * so `{{#if form.x}}` and `contains` read them as answers, not as text).
 */
export type TemplateVarMap = Record<TemplateVariable, string> & Record<string, TemplateValue>;

export { FORM_VARIABLE_PREFIX, formVariable };

/** All variable names a template reads (canonical; aliases resolved). */
export function extractTokens(text: string): string[] {
  return templateVariableNames(text);
}

/**
 * Names in the text that will render empty (flagged in the preview and in the
 * event editor's dangling-reference warning).
 *
 * `formFields` is the set of intake field names on the event type being edited;
 * pass it and `{{form.x}}` counts as known when `x` is one of them. Omit it
 * (the account-level preview, which has no event) and every `form.` name is
 * reported, which is the honest answer there.
 */
export function unknownTokens(text: string, formFields?: readonly string[]): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  for (const f of formFields ?? []) known.add(formVariable(f));
  return extractTokens(text).filter((t) => !known.has(t));
}

/** Locale-aware "Sat, Aug 1, 11:00 AM EDT" in the given time zone. */
export function formatWhen(iso: string, tz: string, locale: TemplateLocale = 'en'): string {
  try {
    return new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "in 24 hour(s)" / "en 30 minutos" — the reminder lead phrase. */
export function formatLead(leadMinutes: number | undefined, locale: TemplateLocale): string {
  if (leadMinutes == null) return locale === 'es' ? 'pronto' : 'soon';
  const day = 1440;
  if (leadMinutes % day === 0) {
    const d = leadMinutes / day;
    return locale === 'es' ? `en ${d} día(s)` : `in ${d} day(s)`;
  }
  if (leadMinutes % 60 === 0) {
    const h = leadMinutes / 60;
    return locale === 'es' ? `en ${h} hora(s)` : `in ${h} hour(s)`;
  }
  return locale === 'es' ? `en ${leadMinutes} minutos` : `in ${leadMinutes} minutes`;
}

/** "30 min", "1 h", "1 h 30 min": the meeting length, the same in EN and ES. */
export function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * One intake answer as the engine reads it. Text, numbers and yes/no stay as
 * they are and lists keep their items, so the engine can word a boolean in the
 * reader's language and test a list item by item. Anything else (an object, a
 * nested list) is not an answer a form produces and reads as empty.
 */
function answerValue(value: unknown): TemplateValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
  }
  return null;
}

/**
 * The `{{form.<field name>}}` half of the variable map, built from the
 * booking's own intake answers. Own properties only, and every key is
 * `form.`-prefixed, so an answer can never collide with a built-in.
 */
export function formVars(answers: Record<string, unknown> | null | undefined): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = Object.create(null) as Record<string, TemplateValue>;
  if (!answers) return out;
  for (const [name, value] of Object.entries(answers)) {
    out[formVariable(name)] = answerValue(value);
  }
  return out;
}

/**
 * The invitee's tokenised manage link, for the invitee's copy only. The link
 * reschedules or cancels THE INVITEE's booking, so a host copy never carries
 * it: not as a button, not as a template variable, not as a text line. A host
 * manages bookings from their own bookings page.
 */
export function inviteeManageUrl(n: Pick<BookingNotification, 'audience' | 'manageUrl'>): string {
  return n.audience === 'host' ? '' : (n.manageUrl ?? '');
}

/**
 * The zone a message's times are written in: the reader's own. The host's copy
 * reads in the host's zone and the invitee's copy in the invitee's, so neither
 * side has to convert a time stated in the other's. Co-hosts share the host
 * side's one message, so they read the organizer's zone. A host copy whose
 * payload carries no readable host zone (queued before it was carried, built by
 * a fork, or a corrupt stored value) and a legacy message with no audience keep
 * the attendee's zone.
 */
export function recipientTimeZone(
  n: Pick<BookingNotification, 'audience' | 'host' | 'attendee'>,
): string {
  if (n.audience === 'host' && isValidTimeZone(n.host.timeZone)) return n.host.timeZone;
  return n.attendee.timeZone ?? 'UTC';
}

/** The invitee's zone, as stored; UTC when it is missing or unreadable. */
function attendeeTimeZone(n: Pick<BookingNotification, 'attendee'>): string {
  return isValidTimeZone(n.attendee.timeZone) ? n.attendee.timeZone : 'UTC';
}

/** The host's zone; the invitee's when the payload carries no readable one. */
function hostTimeZone(n: Pick<BookingNotification, 'host' | 'attendee'>): string {
  return isValidTimeZone(n.host.timeZone) ? n.host.timeZone : attendeeTimeZone(n);
}

/**
 * Build the variable map for one notification. Times are formatted in the
 * reader's zone (`recipientTimeZone`), subject included, since the subject
 * renders from these same variables; `*_host` and `*_attendee` name one side's
 * zone explicitly. `{{form.*}}` entries come from the answers snapshotted onto
 * the notification. Fields a payload queued before they existed does not carry
 * read as empty (or, for the event name, as the booking title it always was).
 */
export function templateVars(
  n: BookingNotification & { reminderLeadMinutes?: number },
  locale: TemplateLocale = 'en',
): TemplateVarMap {
  const tz = recipientTimeZone(n);
  const hostTz = hostTimeZone(n);
  const attendeeTz = attendeeTimeZone(n);
  const pendingNote = n.pending
    ? locale === 'es'
      ? 'Esta solicitud está pendiente de tu confirmación.'
      : 'This request is pending your confirmation.'
    : '';
  const attendeeName = n.attendee.name ?? '';
  // Kept as its own typed map so the compiler still enforces that every
  // built-in has a value; the form namespace is open by nature and merges on
  // top without being able to shadow one (every key is `form.`-prefixed).
  const builtIn: Record<TemplateVariable, string> = {
    attendee_name: attendeeName,
    attendee_first_name: attendeeName.trim().split(/\s+/)[0] ?? '',
    attendee_email: n.attendee.email ?? '',
    attendee_phone: n.attendee.phone?.trim() ?? '',
    guests: (n.guests ?? []).map((g) => g.email).filter(Boolean).join(', '),
    attendee_time_zone: n.attendee.timeZone ?? '',
    host_name: n.host.name ?? '',
    host_email: n.host.email ?? '',
    event_name: n.eventName ?? n.title,
    event_title: n.title,
    event_description: n.eventDescription ?? '',
    duration: formatDuration(n.startUtc, n.endUtc),
    location: n.location ?? '',
    workspace_name: n.workspaceName ?? '',
    team_name: n.teamName ?? '',
    start_time: formatWhen(n.startUtc, tz, locale),
    end_time: formatWhen(n.endUtc, tz, locale),
    start_time_host: formatWhen(n.startUtc, hostTz, locale),
    end_time_host: formatWhen(n.endUtc, hostTz, locale),
    start_time_attendee: formatWhen(n.startUtc, attendeeTz, locale),
    end_time_attendee: formatWhen(n.endUtc, attendeeTz, locale),
    time_zone: tz,
    previous_start_time: n.previousStartUtc ? formatWhen(n.previousStartUtc, tz, locale) : '',
    reminder_lead: formatLead(n.reminderLeadMinutes, locale),
    meeting_url: n.meetingUrl ?? '',
    manage_url: inviteeManageUrl(n),
    cancel_link: inviteeManageUrl(n),
    reschedule_link: inviteeManageUrl(n),
    booking_link: n.bookingLink ?? '',
    booking_uid: n.uid,
    cancellation_reason: n.cancellationReason ?? '',
    pending_note: pendingNote,
  };
  // Safe by construction: `builtIn` is exhaustive above, and every form key is
  // `form.`-prefixed so the spread cannot drop or shadow one.
  return { ...builtIn, ...formVars(n.formAnswers) } as TemplateVarMap;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A subject is one header line; 255 is what every mail and calendar backend keeps. */
export const MAX_RENDERED_SUBJECT = 255;
/** The plain-text body, after every value is in. */
export const MAX_RENDERED_BODY = 20_000;

/**
 * Render a template with the engine (`@slate/engine`): values, fallbacks and
 * `{{#if}}` blocks, single pass, own-property lookup, every value cleaned and
 * capped. The subject renders on one line; the body keeps the empty-line rule.
 * The HTML variant escapes the whole rendered text (template text AND values),
 * so neither an edited template nor attendee-supplied data can inject markup.
 * `locale` words yes/no answers.
 */
export function renderTemplate(
  template: EmailTemplate,
  vars: Readonly<Record<string, TemplateValue>>,
  locale: TemplateLocale = 'en',
): RenderedEmail {
  const subject = renderWithEngine(template.subject, vars, {
    mode: 'line',
    locale,
    maxLength: MAX_RENDERED_SUBJECT,
  });
  const text = renderWithEngine(template.body, vars, { mode: 'text', locale, maxLength: MAX_RENDERED_BODY });
  const html = `<p>${text.split('\n').map(escapeHtml).join('<br/>')}</p>`;
  return { subject, text, html };
}

/* ------------------------------------------------------------------------ *
 * Shipped defaults. EN copy intentionally matches the pre-template emails   *
 * so forks that never touch Settings see identical mail.                    *
 * ------------------------------------------------------------------------ */

const EN: Record<EmailTemplateKey, EmailTemplate> = {
  attendee_confirmation: {
    subject: 'Confirmed: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

Your booking "{{event_title}}" is confirmed.
When: {{start_time}}
Host: {{host_name}}
Where: {{location}}
Join the meeting: {{meeting_url}}
Manage your booking: {{manage_url}}`,
  },
  attendee_pending: {
    subject: 'Request received: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

We received your request to book "{{event_title}}".
When: {{start_time}}
Host: {{host_name}}
This is pending confirmation. You'll get another email once it's confirmed.
Cancel this request: {{manage_url}}`,
  },
  attendee_declined: {
    subject: 'Not accepted: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

Unfortunately your request to book "{{event_title}}" ({{start_time}}) was not accepted.
Reason: {{cancellation_reason}}`,
  },
  attendee_reschedule: {
    subject: 'Rescheduled: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

Your booking "{{event_title}}" has been rescheduled.
Was: {{previous_start_time}}
Now: {{start_time}}
Host: {{host_name}}
Where: {{location}}
Join the meeting: {{meeting_url}}
Manage your booking: {{manage_url}}`,
  },
  attendee_cancellation: {
    subject: 'Cancelled: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

Your booking "{{event_title}}" ({{start_time}}) has been cancelled.
Reason: {{cancellation_reason}}`,
  },
  attendee_reminder: {
    subject: 'Reminder: {{event_title}} — {{start_time}}',
    body: `Hi {{attendee_name}},

Reminder: "{{event_title}}" starts {{reminder_lead}}.
When: {{start_time}}
Host: {{host_name}}
Where: {{location}}
Join the meeting: {{meeting_url}}
Manage your booking: {{manage_url}}`,
  },
  host_booked: {
    subject: 'New booking: {{event_title}} — {{start_time}}',
    body: `Hi {{host_name}},

{{attendee_name}} ({{attendee_email}}) booked "{{event_title}}".
When: {{start_time}}
Where: {{location}}
Join the meeting: {{meeting_url}}
{{pending_note}}`,
  },
  host_rescheduled: {
    subject: 'Rescheduled: {{event_title}} — {{start_time}}',
    body: `Hi {{host_name}},

The booking "{{event_title}}" with {{attendee_name}} has been rescheduled.
Was: {{previous_start_time}}
Now: {{start_time}}
Where: {{location}}
Join the meeting: {{meeting_url}}`,
  },
  host_cancelled: {
    subject: 'Cancelled: {{event_title}} — {{start_time}}',
    body: `Hi {{host_name}},

The booking "{{event_title}}" ({{start_time}}) with {{attendee_name}} has been cancelled.
Reason: {{cancellation_reason}}`,
  },
  host_declined: {
    subject: 'Declined: {{event_title}} — {{start_time}}',
    body: `Hi {{host_name}},

The booking request from {{attendee_name}} ({{attendee_email}}) for "{{event_title}}" ({{start_time}}) was declined.
Reason: {{cancellation_reason}}`,
  },
  host_reminder: {
    subject: 'Reminder: {{event_title}} — {{start_time}}',
    body: `Hi {{host_name}},

Reminder: "{{event_title}}" with {{attendee_name}} starts {{reminder_lead}}.
When: {{start_time}}
Where: {{location}}
Join the meeting: {{meeting_url}}`,
  },
  follow_up: {
    subject: 'Thanks for meeting — {{event_title}}',
    body: `Hi {{attendee_name}},

Thanks for taking the time for "{{event_title}}" — we hope it was useful.
Want to talk again? Book another slot: {{booking_link}}`,
  },
};

const ES: Record<EmailTemplateKey, EmailTemplate> = {
  attendee_confirmation: {
    subject: 'Confirmada: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Tu reserva "{{event_title}}" está confirmada.
Cuándo: {{start_time}}
Anfitrión: {{host_name}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}
Gestiona tu reserva: {{manage_url}}`,
  },
  attendee_pending: {
    subject: 'Solicitud recibida: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Recibimos tu solicitud para reservar "{{event_title}}".
Cuándo: {{start_time}}
Anfitrión: {{host_name}}
Está pendiente de confirmación. Recibirás otro correo cuando se confirme.
Cancelar esta solicitud: {{manage_url}}`,
  },
  attendee_declined: {
    subject: 'No aceptada: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Lamentablemente tu solicitud para reservar "{{event_title}}" ({{start_time}}) no fue aceptada.
Motivo: {{cancellation_reason}}`,
  },
  attendee_reschedule: {
    subject: 'Reprogramada: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Tu reserva "{{event_title}}" ha sido reprogramada.
Antes: {{previous_start_time}}
Ahora: {{start_time}}
Anfitrión: {{host_name}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}
Gestiona tu reserva: {{manage_url}}`,
  },
  attendee_cancellation: {
    subject: 'Cancelada: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Tu reserva "{{event_title}}" ({{start_time}}) ha sido cancelada.
Motivo: {{cancellation_reason}}`,
  },
  attendee_reminder: {
    subject: 'Recordatorio: {{event_title}} — {{start_time}}',
    body: `Hola {{attendee_name}},

Recordatorio: "{{event_title}}" comienza {{reminder_lead}}.
Cuándo: {{start_time}}
Anfitrión: {{host_name}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}
Gestiona tu reserva: {{manage_url}}`,
  },
  host_booked: {
    subject: 'Nueva reserva: {{event_title}} — {{start_time}}',
    body: `Hola {{host_name}},

{{attendee_name}} ({{attendee_email}}) reservó "{{event_title}}".
Cuándo: {{start_time}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}
{{pending_note}}`,
  },
  host_rescheduled: {
    subject: 'Reprogramada: {{event_title}} — {{start_time}}',
    body: `Hola {{host_name}},

La reserva "{{event_title}}" con {{attendee_name}} ha sido reprogramada.
Antes: {{previous_start_time}}
Ahora: {{start_time}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}`,
  },
  host_cancelled: {
    subject: 'Cancelada: {{event_title}} — {{start_time}}',
    body: `Hola {{host_name}},

La reserva "{{event_title}}" ({{start_time}}) con {{attendee_name}} ha sido cancelada.
Motivo: {{cancellation_reason}}`,
  },
  host_declined: {
    subject: 'Rechazada: {{event_title}} — {{start_time}}',
    body: `Hola {{host_name}},

La solicitud de reserva de {{attendee_name}} ({{attendee_email}}) para "{{event_title}}" ({{start_time}}) fue rechazada.
Motivo: {{cancellation_reason}}`,
  },
  host_reminder: {
    subject: 'Recordatorio: {{event_title}} — {{start_time}}',
    body: `Hola {{host_name}},

Recordatorio: "{{event_title}}" con {{attendee_name}} comienza {{reminder_lead}}.
Cuándo: {{start_time}}
Dónde: {{location}}
Unirse a la reunión: {{meeting_url}}`,
  },
  follow_up: {
    subject: 'Gracias por la reunión — {{event_title}}',
    body: `Hola {{attendee_name}},

Gracias por tu tiempo en "{{event_title}}" — esperamos que haya sido útil.
¿Quieres volver a hablar? Reserva otro espacio: {{booking_link}}`,
  },
};

export const DEFAULT_TEMPLATES: Record<TemplateLocale, Record<EmailTemplateKey, EmailTemplate>> = {
  en: EN,
  es: ES,
};

/** The shipped default for a key (EN fallback for any unknown locale). */
export function defaultTemplate(key: EmailTemplateKey, locale?: string | null): EmailTemplate {
  const l: TemplateLocale = locale === 'es' ? 'es' : 'en';
  return DEFAULT_TEMPLATES[l][key];
}

/**
 * Resolve the effective template: per-field override (custom subject may pair
 * with the default body, and vice versa) over the shipped default.
 */
export function resolveTemplate(
  key: EmailTemplateKey,
  custom: { subject?: string | null; body?: string | null } | null | undefined,
  locale?: string | null,
): EmailTemplate {
  const base = defaultTemplate(key, locale);
  return {
    subject: custom?.subject ?? base.subject,
    body: custom?.body ?? base.body,
  };
}
