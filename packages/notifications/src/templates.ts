/**
 * EMAIL TEMPLATES — the editable layer of the notification system.
 *
 * Every booking email renders from a { subject, body } template: the shipped
 * defaults below (EN/ES, per email key) or a per-account override stored in
 * `notification_setting`. Bodies are PLAIN TEXT with `{{variable}}` tokens —
 * no user-authored HTML ever reaches an email (public-facing hardening E8):
 * rendering escapes both template text and substituted values, and only
 * whitelisted variables resolve; unknown tokens render empty.
 *
 * Line rule (keeps optional fields tidy, mirrors the pre-template behavior):
 * a line that contains tokens which ALL resolve empty is dropped — so
 * "Where: {{location}}" vanishes when there is no location, and
 * "{{pending_note}}" only appears for approval-required bookings.
 */
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

export type TemplateLocale = 'en' | 'es';

export interface EmailTemplate {
  subject: string;
  body: string;
}

/** The variable whitelist — the ONLY tokens that resolve (editor shows these). */
export const TEMPLATE_VARIABLES = [
  'attendee_name',
  'attendee_email',
  'host_name',
  'event_title',
  'start_time',
  'end_time',
  'location',
  // The conferencing link. UNIQUE among these: it is the one variable resolved
  // at DELIVERY time rather than snapshotted at enqueue, because it is minted
  // later by the calendar outbox row (ADR 0007). Empty when the write-out has
  // not produced one — the empty-line rule then drops its whole line.
  'meeting_url',
  'manage_url',
  'cancel_link',
  'reschedule_link',
  'cancellation_reason',
  'previous_start_time',
  'reminder_lead',
  'pending_note',
  'booking_link',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * The rendered variable map: every built-in is present (the renderer may read
 * `v.start_time` without a guard), plus an open tail for the `{{form.*}}`
 * namespace, whose names are only known at run time.
 */
export type TemplateVarMap = Record<TemplateVariable, string> & Record<string, string>;

/**
 * `{{built_in}}` or `{{form.<field name>}}`. The `form.` half is the per-event
 * namespace (#68 decision 2): a reminder may quote that event type's own intake
 * answers, and the prefix is what stops a question named `location` from
 * shadowing the built-in `{{location}}` — so no new names are reserved and
 * every already-saved form keeps working. The charset matches what the event
 * editor already sanitizes intake field names to (`[A-Za-z0-9_]`).
 */
const TOKEN_RE = /\{\{\s*([a-z_]+|form\.[A-Za-z0-9_]{1,64})\s*\}\}/g;

/** The `{{form.*}}` namespace prefix. */
export const FORM_VARIABLE_PREFIX = 'form.';

/** The variable name for one intake field — `{{form.budget}}`. */
export function formVariable(fieldName: string): string {
  return `${FORM_VARIABLE_PREFIX}${fieldName}`;
}

/** All `{{token}}` names appearing in a template string (editor validation). */
export function extractTokens(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) names.add(m[1]!);
  return [...names];
}

/**
 * Tokens present in the text that will render empty (flagged in the preview and
 * in the event editor's dangling-reference warning).
 *
 * `formFields` is the set of intake field names on the event type being edited;
 * pass it and `{{form.x}}` counts as known when `x` is one of them. Omit it —
 * the account-level preview, which has no event — and every `form.` token is
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

/**
 * One intake answer as email text. Booleans are the only value that needs the
 * locale — a raw `true` in a reminder body reads as a bug. An absent answer is
 * the empty string, which the line-drop rule then removes along with its label.
 */
function answerText(value: unknown, locale: TemplateLocale): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? (locale === 'es' ? 'Sí' : 'Yes') : locale === 'es' ? 'No' : 'No';
  if (Array.isArray(value)) return value.map((v) => answerText(v, locale)).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/**
 * The `{{form.<field name>}}` half of the variable map, built from the
 * booking's own intake answers. Own properties only, and every key is
 * `form.`-prefixed, so an answer can never collide with a built-in.
 */
export function formVars(
  answers: Record<string, unknown> | null | undefined,
  locale: TemplateLocale = 'en',
): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!answers) return out;
  for (const [name, value] of Object.entries(answers)) {
    out[formVariable(name)] = answerText(value, locale);
  }
  return out;
}

/**
 * Build the variable map for one notification. Times are formatted in the
 * ATTENDEE's time zone for both sides (v1 — the booking's reference zone).
 * `{{form.*}}` entries come from the answers snapshotted onto the notification.
 */
export function templateVars(
  n: BookingNotification & { reminderLeadMinutes?: number },
  locale: TemplateLocale = 'en',
): TemplateVarMap {
  const tz = n.attendee.timeZone ?? 'UTC';
  const pendingNote = n.pending
    ? locale === 'es'
      ? 'Esta solicitud está pendiente de tu confirmación.'
      : 'This request is pending your confirmation.'
    : '';
  // Kept as its own typed map so the compiler still enforces that every
  // built-in has a value; the form namespace is open by nature and merges on
  // top without being able to shadow one (every key is `form.`-prefixed).
  const builtIn: Record<TemplateVariable, string> = {
    attendee_name: n.attendee.name ?? '',
    attendee_email: n.attendee.email ?? '',
    host_name: n.host.name ?? '',
    event_title: n.title,
    start_time: formatWhen(n.startUtc, tz, locale),
    end_time: formatWhen(n.endUtc, tz, locale),
    location: n.location ?? '',
    meeting_url: n.meetingUrl ?? '',
    manage_url: n.manageUrl ?? '',
    cancel_link: n.manageUrl ?? '',
    reschedule_link: n.manageUrl ?? '',
    cancellation_reason: n.cancellationReason ?? '',
    previous_start_time: n.previousStartUtc ? formatWhen(n.previousStartUtc, tz, locale) : '',
    reminder_lead: formatLead(n.reminderLeadMinutes, locale),
    pending_note: pendingNote,
    booking_link: n.bookingLink ?? '',
  };
  // Safe by construction: `builtIn` is exhaustive above, and every form key is
  // `form.`-prefixed so the spread cannot drop or shadow one.
  return { ...builtIn, ...formVars(n.formAnswers, locale) } as TemplateVarMap;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Own-property lookup only — `{{constructor}}`/`{{__proto__}}` must resolve
 *  empty, never reach into Object.prototype and stringify a function. */
function varValue(vars: Record<string, string>, name: string): string {
  return Object.hasOwn(vars, name) ? (vars[name] ?? '') : '';
}

function substituteLine(line: string, vars: Record<string, string>): string | null {
  let sawToken = false;
  let sawValue = false;
  const out = line.replace(TOKEN_RE, (_, name: string) => {
    sawToken = true;
    const v = varValue(vars, name);
    if (v !== '') sawValue = true;
    return v;
  });
  // Drop a line whose tokens all resolved empty ("Where: {{location}}" with no
  // location) — literal-only lines always stay.
  if (sawToken && !sawValue) return null;
  return out;
}

/**
 * Render a template against the whitelist variables. Safe by construction:
 * the HTML variant escapes the whole substituted line (template text AND
 * values), so neither an edited template nor attendee-supplied data can inject
 * markup. Unknown tokens resolve empty.
 */
export function renderTemplate(
  template: EmailTemplate,
  vars: Record<string, string>,
): RenderedEmail {
  const subject = template.subject
    .replace(TOKEN_RE, (_, name: string) => varValue(vars, name))
    .replace(/\s+/g, ' ')
    .trim();
  const lines = template.body
    .split('\n')
    .map((l) => substituteLine(l, vars))
    .filter((l): l is string => l !== null);
  // Collapse runs of blank lines left behind by dropped neighbors.
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
