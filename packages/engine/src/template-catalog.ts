/**
 * The template variables catalog: every `{{name}}` a host may write, as DATA.
 *
 * One list feeds the save-time validator, the editor's variable picker, the
 * preview's sample values, the API docs and the MCP tools, so a variable can
 * never be offered in one place and refused (or silently empty) in another.
 *
 * Contexts say WHERE a variable can resolve:
 *   - `title`       the calendar event title, rendered once at booking time;
 *   - `description` the calendar event body, rendered once at booking time;
 *   - `email`       email subjects and bodies, rendered at send time.
 * A variable missing from a context is refused there at save time with a
 * "not available here" message rather than rendering empty forever: the manage
 * link, for instance, is a capability that must never sit in a calendar event
 * shared with guests, the meeting link does not exist yet when the event is
 * first written, and the booking page link needs the deployment's public
 * address, which only the mail sender is configured with.
 *
 * `hostOnly` marks a variable that reads other people's data, so it resolves
 * only in the host's copy of an email: `guests` lists everyone else on the
 * booking, and on a group event those are strangers to each invitee.
 *
 * `perInvitee` marks the data of the one person who booked. On an event with
 * seats, everyone who takes a seat is a guest on the same calendar event, so
 * its title and description cannot carry one invitee's name, contact details
 * or answers: they are refused there (and render empty if one slips through).
 */

export const TEMPLATE_CONTEXTS = ['title', 'description', 'email'] as const;
export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];

export type TemplateLocale = 'en' | 'es';

/** Who reads a rendered text: the invitee (and anyone they share it with) or the host side. */
export type TemplateAudience = 'invitee' | 'host';

export const TEMPLATE_VARIABLE_GROUPS = ['invitee', 'host', 'event', 'time', 'links', 'booking'] as const;
export type TemplateVariableGroup = (typeof TEMPLATE_VARIABLE_GROUPS)[number];

export interface TemplateVariableDef {
  name: string;
  group: TemplateVariableGroup;
  contexts: readonly TemplateContext[];
  label: Record<TemplateLocale, string>;
  /** What the preview shows for this variable. */
  sample: Record<TemplateLocale, string>;
  /** Resolves only in the host's copy (see the header). */
  hostOnly?: true;
  /** One invitee's data, kept out of a seated event's shared calendar text (see the header). */
  perInvitee?: true;
}

const ALL: readonly TemplateContext[] = ['title', 'description', 'email'];
const BODY: readonly TemplateContext[] = ['description', 'email'];
const EMAIL: readonly TemplateContext[] = ['email'];

function v(
  name: string,
  group: TemplateVariableGroup,
  contexts: readonly TemplateContext[],
  label: [string, string],
  sample: [string, string],
  flags: { hostOnly?: true; perInvitee?: true } = {},
): TemplateVariableDef {
  return {
    name,
    group,
    contexts,
    label: { en: label[0], es: label[1] },
    sample: { en: sample[0], es: sample[1] },
    ...flags,
  };
}

const INVITEE = { perInvitee: true } as const;

/**
 * The built-in variables, grouped for the picker. Every name of the email
 * whitelist that shipped before this catalog existed is here, unchanged and
 * still available in email, so every stored template keeps resolving exactly
 * as it did.
 */
export const TEMPLATE_CATALOG: readonly TemplateVariableDef[] = [
  v('attendee_name', 'invitee', ALL, ['Invitee name', 'Nombre del invitado'], ['Ana Gómez', 'Ana Gómez'], INVITEE),
  v('attendee_first_name', 'invitee', ALL, ['Invitee first name', 'Nombre de pila del invitado'], ['Ana', 'Ana'], INVITEE),
  v('attendee_email', 'invitee', ALL, ['Invitee email', 'Correo del invitado'], ['ana@example.com', 'ana@example.com'], INVITEE),
  v('attendee_phone', 'invitee', ALL, ['Invitee phone', 'Teléfono del invitado'], ['+57 300 123 4567', '+57 300 123 4567'], INVITEE),
  v('guests', 'invitee', EMAIL, ['Other guests', 'Otros invitados'], ['luis@example.com', 'luis@example.com'], { hostOnly: true }),
  v('attendee_time_zone', 'invitee', BODY, ['Invitee time zone', 'Zona horaria del invitado'], ['America/Bogota', 'America/Bogota'], INVITEE),
  v('host_name', 'host', ALL, ['Host name', 'Nombre del anfitrión'], ['Felipe Gómez', 'Felipe Gómez']),
  v('host_email', 'host', BODY, ['Host email', 'Correo del anfitrión'], ['felipe@example.com', 'felipe@example.com']),
  v('event_name', 'event', ALL, ['Event name', 'Nombre del evento'], ['Product demo', 'Demo del producto']),
  v('event_title', 'event', ALL, ['Meeting title', 'Título de la reunión'], ['Product demo', 'Demo del producto']),
  v('event_description', 'event', BODY, ['Event description', 'Descripción del evento'], ['A 30 minute walkthrough.', 'Un recorrido de 30 minutos.']),
  v('duration', 'event', ALL, ['Duration', 'Duración'], ['30 min', '30 min']),
  v('location', 'event', ALL, ['Location', 'Ubicación'], ['Video call', 'Videollamada']),
  v('workspace_name', 'event', ALL, ['Workspace name', 'Nombre del espacio de trabajo'], ['Dapta', 'Dapta']),
  v('team_name', 'event', ALL, ['Team name', 'Nombre del equipo'], ['Sales', 'Ventas']),
  v('start_time', 'time', ALL, ['Start time', 'Hora de inicio'], ['Tue, Oct 21, 10:00 AM GMT-5', 'mar, 21 oct, 10:00 GMT-5']),
  v('end_time', 'time', ALL, ['End time', 'Hora de fin'], ['Tue, Oct 21, 10:30 AM GMT-5', 'mar, 21 oct, 10:30 GMT-5']),
  v('start_time_host', 'time', BODY, ['Start time (host zone)', 'Hora de inicio (zona del anfitrión)'], ['Tue, Oct 21, 10:00 AM GMT-5', 'mar, 21 oct, 10:00 GMT-5']),
  v('end_time_host', 'time', BODY, ['End time (host zone)', 'Hora de fin (zona del anfitrión)'], ['Tue, Oct 21, 10:30 AM GMT-5', 'mar, 21 oct, 10:30 GMT-5']),
  v('start_time_attendee', 'time', BODY, ['Start time (invitee zone)', 'Hora de inicio (zona del invitado)'], ['Tue, Oct 21, 10:00 AM GMT-5', 'mar, 21 oct, 10:00 GMT-5'], INVITEE),
  v('end_time_attendee', 'time', BODY, ['End time (invitee zone)', 'Hora de fin (zona del invitado)'], ['Tue, Oct 21, 10:30 AM GMT-5', 'mar, 21 oct, 10:30 GMT-5'], INVITEE),
  v('time_zone', 'time', BODY, ['Time zone', 'Zona horaria'], ['America/Bogota', 'America/Bogota']),
  v('previous_start_time', 'time', EMAIL, ['Previous start time', 'Hora de inicio anterior'], ['Mon, Oct 20, 3:00 PM GMT-5', 'lun, 20 oct, 15:00 GMT-5']),
  v('reminder_lead', 'time', EMAIL, ['Time until the meeting', 'Tiempo para la reunión'], ['in 1 day(s)', 'en 1 día(s)']),
  v('meeting_url', 'links', EMAIL, ['Meeting link', 'Enlace de la reunión'], ['https://meet.example.com/abc-defg-hij', 'https://meet.example.com/abc-defg-hij']),
  v('manage_url', 'links', EMAIL, ['Manage booking link', 'Enlace para gestionar la reserva'], ['https://calendar.example.com/manage/abc', 'https://calendar.example.com/manage/abc']),
  v('cancel_link', 'links', EMAIL, ['Cancel link', 'Enlace para cancelar'], ['https://calendar.example.com/manage/abc', 'https://calendar.example.com/manage/abc']),
  v('reschedule_link', 'links', EMAIL, ['Reschedule link', 'Enlace para reprogramar'], ['https://calendar.example.com/manage/abc', 'https://calendar.example.com/manage/abc']),
  v('booking_link', 'links', EMAIL, ['Booking page link', 'Enlace de la página de reservas'], ['https://calendar.example.com/dapta/felipe/demo', 'https://calendar.example.com/dapta/felipe/demo']),
  v('booking_uid', 'booking', BODY, ['Booking reference', 'Referencia de la reserva'], ['b7c1e2d4', 'b7c1e2d4']),
  v('cancellation_reason', 'booking', EMAIL, ['Cancellation reason', 'Motivo de la cancelación'], ['A conflict came up.', 'Me surgió un imprevisto.']),
  v('pending_note', 'booking', EMAIL, ['Pending approval note', 'Nota de aprobación pendiente'], ['This request is pending your confirmation.', 'Esta solicitud está pendiente de tu confirmación.']),
];

/**
 * Short names hosts type naturally (`Meeting Felipe - {{name}}`). They resolve
 * to the canonical variable; the picker always inserts the canonical name.
 */
export const TEMPLATE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  name: 'attendee_name',
  first_name: 'attendee_first_name',
  email: 'attendee_email',
});

/** The answers namespace: `{{form.<question name>}}`. */
export const FORM_VARIABLE_PREFIX = 'form.';

/** The question-name charset the editor already enforces (`[A-Za-z0-9_]`, 1 to 64). */
export const FORM_FIELD_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

const BY_NAME: ReadonlyMap<string, TemplateVariableDef> = new Map(TEMPLATE_CATALOG.map((d) => [d.name, d]));

/** The canonical name for an alias, or the name itself. */
export function canonicalVariable(name: string): string {
  return Object.hasOwn(TEMPLATE_ALIASES, name) ? TEMPLATE_ALIASES[name]! : name;
}

export function templateVariable(name: string): TemplateVariableDef | undefined {
  return BY_NAME.get(canonicalVariable(name));
}

/**
 * The catalog entries usable in one context, in catalog order. With an
 * audience, only those that resolve for it (no host-only variable for the
 * invitee); without one, all of them.
 */
export function variablesFor(context: TemplateContext, audience?: TemplateAudience): TemplateVariableDef[] {
  return TEMPLATE_CATALOG.filter(
    (d) => d.contexts.includes(context) && !(audience === 'invitee' && d.hostOnly),
  );
}

export function isFormVariable(name: string): boolean {
  return name.startsWith(FORM_VARIABLE_PREFIX);
}

/** `{{form.budget}}` names the answer to the question `budget`. */
export function formVariable(fieldName: string): string {
  return `${FORM_VARIABLE_PREFIX}${fieldName}`;
}
