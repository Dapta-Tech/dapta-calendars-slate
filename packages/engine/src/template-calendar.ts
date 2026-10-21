/**
 * The calendar event's own text: the title and description a host writes per
 * event type (`Meeting Felipe - {{name}}`). Rendered when a booking is placed
 * and again when it moves, then stored on the booking, so the calendar write,
 * both .ics files, the emails' `{{event_title}}`, the confirmation, the manage
 * page and the CRM all read one string.
 *
 * The reader is the host: the event is written to the host's calendar, in the
 * host's language, and its times read in the host's zone. The invitee is a
 * guest on that same event, so nothing here may be private to the host either:
 * the catalog keeps the manage link and other people's addresses out of these
 * contexts, and on an event with seats, where every seat-taker is a guest,
 * one invitee's own data is left out too (`perInvitee`).
 *
 * Pure: the caller loads the booking and passes it in.
 */
import {
  capTemplateText,
  formatTemplateDuration,
  formatTemplateTime,
  renderTemplate,
  stripUnsafeText,
  templateFirstName,
  templateFormValues,
  type TemplateValue,
} from './template';
import { variablesFor, type TemplateContext, type TemplateLocale } from './template-catalog';

/** The longest calendar title: the subject length every common calendar provider keeps whole. */
export const MAX_CALENDAR_TITLE = 255;
/** The longest calendar description, under the 8,192 characters a common provider is reported to keep. */
export const MAX_CALENDAR_DESCRIPTION = 8000;

/** One booking, as the calendar text reads it. */
export interface CalendarTextInput {
  /** The host's language (the event is written to the host's calendar). */
  locale: TemplateLocale;
  /** The event type has seats: everyone on the slot is a guest on this one event. */
  seated: boolean;
  uid: string;
  /** The event type's name: `{{event_name}}`, and the title when a template renders empty. */
  eventName: string;
  /**
   * The booking's title as stored, for `{{event_title}}` in the description
   * when there is no title template (the emails' `{{event_title}}` reads the
   * same column). Absent: the event's name.
   */
  bookingTitle?: string;
  eventDescription?: string | null;
  startUtc: string;
  endUtc: string;
  /** The Where in words, as the emails print it. */
  location?: string | null;
  workspaceName?: string | null;
  teamName?: string | null;
  host: { name?: string | null; email?: string | null; timeZone?: string | null };
  /** The invitee who booked. */
  attendee: { name?: string | null; email?: string | null; phone?: string | null; timeZone?: string | null };
  /** The booking form's answers; only those to `questions` are read. */
  answers?: Readonly<Record<string, unknown>> | null;
  /** The event type's question names. */
  questions: readonly string[];
}

/** An event type's two templates; null or blank is "none". */
export interface CalendarTemplates {
  title?: string | null;
  description?: string | null;
}

/**
 * What a render produced. A text whose template is missing is `undefined`,
 * and the caller decides what the booking keeps (see `applyCalendarTemplates`
 * in @slate/db: a booking never rendered keeps the event's name and no
 * description, exactly how a booking reads without templates).
 */
export interface CalendarText {
  title?: string;
  /** Null when the template rendered to nothing. */
  description?: string | null;
}

function zoneOr(tz: string | null | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/**
 * The values map for one context. Only the variables that context offers are
 * in it, so a stored template that names anything else (written before a rule
 * changed, or by a path that skipped the save-time check) renders it empty
 * rather than leaking it; on a seated event, one invitee's data is left out
 * the same way. `title` is what `{{event_title}}` reads in the description:
 * the title just rendered, else the booking's stored one. In the title itself
 * it is the event's name.
 */
export function calendarTemplateValues(
  input: CalendarTextInput,
  context: Extract<TemplateContext, 'title' | 'description'>,
  title?: string,
): Record<string, TemplateValue> {
  const attendeeTz = zoneOr(input.attendee.timeZone, 'UTC');
  // A shared slot never falls back to one invitee's zone for the host's.
  const hostTz = zoneOr(input.host.timeZone, input.seated ? 'UTC' : attendeeTz);
  const name = input.attendee.name ?? '';
  const all: Record<string, TemplateValue> = {
    attendee_name: name,
    attendee_first_name: templateFirstName(name),
    attendee_email: input.attendee.email ?? '',
    attendee_phone: input.attendee.phone?.trim() ?? '',
    attendee_time_zone: input.attendee.timeZone ?? '',
    host_name: input.host.name ?? '',
    host_email: input.host.email ?? '',
    event_name: input.eventName,
    // A shared slot's stored title may predate its seats: never read it back.
    event_title:
      context === 'title' ? input.eventName : (title ?? (input.seated ? undefined : input.bookingTitle) ?? input.eventName),
    event_description: input.eventDescription ?? '',
    duration: formatTemplateDuration(input.startUtc, input.endUtc),
    location: input.location ?? '',
    workspace_name: input.workspaceName ?? '',
    team_name: input.teamName ?? '',
    start_time: formatTemplateTime(input.startUtc, hostTz, input.locale),
    end_time: formatTemplateTime(input.endUtc, hostTz, input.locale),
    start_time_host: formatTemplateTime(input.startUtc, hostTz, input.locale),
    end_time_host: formatTemplateTime(input.endUtc, hostTz, input.locale),
    start_time_attendee: formatTemplateTime(input.startUtc, attendeeTz, input.locale),
    end_time_attendee: formatTemplateTime(input.endUtc, attendeeTz, input.locale),
    time_zone: hostTz,
    booking_uid: input.uid,
  };
  const out: Record<string, TemplateValue> = Object.create(null) as Record<string, TemplateValue>;
  for (const def of variablesFor(context)) {
    if (input.seated && def.perInvitee) continue;
    if (Object.hasOwn(all, def.name)) out[def.name] = all[def.name];
  }
  if (!input.seated) Object.assign(out, templateFormValues(input.answers, input.questions));
  return out;
}

/** The event's name as a calendar title: as written, never parsed (it is not a template), cleaned and capped. */
export function plainCalendarTitle(eventName: string): string {
  return capTemplateText(stripUnsafeText(eventName).replace(/\s+/g, ' ').trim(), MAX_CALENDAR_TITLE);
}

function given(template: string | null | undefined): template is string {
  return typeof template === 'string' && template.trim() !== '';
}

/**
 * Render an event type's calendar title and description for one booking.
 * Values lose `<` and `>` on top of the usual cleaning: providers render some
 * markup in descriptions, and a visitor's answer must never become a link or
 * a tag there. A title that renders empty falls back to the event's name.
 * Never throws (the engine fails soft), so a template cannot block a booking.
 */
export function renderCalendarText(templates: CalendarTemplates, input: CalendarTextInput): CalendarText {
  const out: CalendarText = {};
  if (given(templates.title)) {
    const rendered = renderTemplate(templates.title, calendarTemplateValues(input, 'title'), {
      mode: 'line',
      locale: input.locale,
      maxLength: MAX_CALENDAR_TITLE,
      stripAngleBrackets: true,
    });
    out.title = rendered || plainCalendarTitle(input.eventName);
  }
  if (given(templates.description)) {
    const values = calendarTemplateValues(input, 'description', out.title);
    const rendered = renderTemplate(templates.description, values, {
      mode: 'text',
      locale: input.locale,
      maxLength: MAX_CALENDAR_DESCRIPTION,
      stripAngleBrackets: true,
    });
    out.description = rendered || null;
  }
  return out;
}
