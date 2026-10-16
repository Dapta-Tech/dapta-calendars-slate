/**
 * WHO IS ASKING, AND WHAT THEY ANSWERED: the block the host's copy of a booking
 * carries (the request, the confirmed booking and the move), so a host can
 * decide on a booking from the mail alone. Before it, the host's request said
 * only "<name> (<email>) booked <event>", and everything the booking form had
 * asked was a trip to the dashboard away.
 *
 * Everything here is VISITOR input except the question labels, which are the
 * host's own words. This module produces plain values and plain text only; the
 * HTML half is escaped by the layout (`email-layout.ts`), never here, so
 * nothing in this file may emit markup.
 */
import { isReservedFieldName } from '@slate/shared';
import type { TemplateLocale } from './templates';

/** An answer as the booking stored it (`booking.responses`). */
export type BookingAnswerValue = string | number | boolean | string[];

/** One answered question, labelled as the host wrote it. */
export interface BookingAnswer {
  /** The question's label on the event type (its name when it has none). */
  label: string;
  value: BookingAnswerValue;
  /** The question's field type, when known: a checkbox's "true" reads "Yes". */
  type?: string | null;
}

/** Someone else the booking invites (an extra attendee or an added guest). */
export interface BookingGuest {
  name?: string | null;
  email: string;
}

/** A question on the event type, as `collectBookingAnswers` reads it. */
export interface BookingQuestion {
  name: string;
  label: string;
  type?: string | null;
}

/** The longest one answer may run in a message; the rest is cut. */
export const MAX_ANSWER_CHARS = 2000;
/** The most answers one message lists. */
export const MAX_ANSWERS = 50;

/** C0 controls other than tab and newline: nothing a person typed on purpose. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A multi-line value made safe for a text part: one newline style, no controls. */
function cleanBlock(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
}

/** A value that must fit on one line (a name, an address, a phone number). */
function cleanLine(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(CONTROL, '')
    .trim();
}

function clip(value: string): string {
  return value.length > MAX_ANSWER_CHARS ? `${value.slice(0, MAX_ANSWER_CHARS)}…` : value;
}

/**
 * The stored answer as something a message can show, or null when there is
 * nothing to show (empty, whitespace, an empty list, or a shape the form never
 * produces). `false` is an answer: an unticked box the caller sent on purpose.
 */
function normalizeAnswer(raw: unknown): BookingAnswerValue | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const v = cleanBlock(raw);
    return v ? clip(v) : null;
  }
  if (Array.isArray(raw)) {
    const items = raw
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map((x) => clip(cleanLine(String(x))))
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }
  return null;
}

/**
 * The booking's answers in the event type's question order, labelled as the
 * host wrote the questions, empty ones dropped. An answer to a question the
 * host has since removed is still the visitor's answer: it follows, under the
 * name it was stored with. The fixed fields (name, email, notes) are not
 * questions; the block shows them from the attendee.
 */
export function collectBookingAnswers(
  questions: readonly BookingQuestion[],
  responses: Record<string, unknown> | null | undefined,
): BookingAnswer[] {
  const out: BookingAnswer[] = [];
  const asked = new Set<string>();
  const answers = responses ?? {};
  const own = (key: string) => (Object.hasOwn(answers, key) ? answers[key] : undefined);
  for (const q of questions) {
    asked.add(q.name);
    if (isReservedFieldName(q.name)) continue;
    const value = normalizeAnswer(own(q.name));
    if (value === null) continue;
    out.push({ label: cleanLine(q.label) || q.name, value, type: q.type ?? null });
  }
  for (const key of Object.keys(answers)) {
    if (asked.has(key) || isReservedFieldName(key)) continue;
    const value = normalizeAnswer(answers[key]);
    if (value === null) continue;
    out.push({ label: cleanLine(key), value, type: null });
  }
  return out.slice(0, MAX_ANSWERS);
}

const COPY = {
  en: {
    guestDetails: 'Guest details',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    others: 'Other guests',
    answers: 'Their answers',
    notes: 'Notes',
    yes: 'Yes',
    no: 'No',
    act: 'Confirm or decline',
  },
  es: {
    guestDetails: 'Datos del invitado',
    name: 'Nombre',
    email: 'Correo',
    phone: 'Teléfono',
    others: 'Otros invitados',
    answers: 'Sus respuestas',
    notes: 'Notas',
    yes: 'Sí',
    no: 'No',
    act: 'Confirmar o rechazar',
  },
} as const;

/** The block's words in one locale, shared with the HTML layout. */
export function bookingDetailsCopy(locale: TemplateLocale) {
  return COPY[locale === 'es' ? 'es' : 'en'];
}

const TRUTHY = new Set(['true', 'on', 'yes', '1']);
const FALSY = new Set(['false', 'off', 'no', '0']);

/** One answer as words: Yes/No for a box, a list as "a, b", the rest as typed. */
export function readableAnswer(answer: BookingAnswer, locale: TemplateLocale): string {
  const c = bookingDetailsCopy(locale);
  const v = answer.value;
  if (typeof v === 'boolean') return v ? c.yes : c.no;
  if (Array.isArray(v))
    return v
      .map((x) => cleanLine(String(x)))
      .filter(Boolean)
      .join(', ');
  if (typeof v === 'number') return String(v);
  const text = cleanBlock(String(v ?? ''));
  if (answer.type === 'checkbox') {
    const word = text.toLowerCase();
    if (TRUTHY.has(word)) return c.yes;
    if (FALSY.has(word)) return c.no;
  }
  return text;
}

/** One other guest as a reader names them: "Ana Ruiz (ana@example.com)" or the address. */
export function guestDisplay(g: BookingGuest): string {
  const email = cleanLine(g.email);
  const name = cleanLine(g.name);
  return name && name.toLowerCase() !== email.toLowerCase() ? `${name} (${email})` : email;
}

/** A label and the answer under it, both ready to show (not escaped). */
export interface DetailLine {
  label: string;
  value: string;
}

/** Who the booking is from and what they answered, ready to show. */
export interface BookingDetails {
  guest: { name: string; email: string; phone: string };
  /** Everyone else the booking invites, one display string each. */
  others: string[];
  /** The form in question order, then the notes; nothing empty. */
  answers: DetailLine[];
}

/** The input `bookingDetails` reads: the notification's people and answers. */
export interface BookingDetailsSource {
  attendee: { name: string; email: string; phone?: string | null; notes?: string | null };
  guests?: readonly BookingGuest[] | null;
  answers?: readonly BookingAnswer[] | null;
}

/** Assemble the block from a notification (its snapshotted people and answers). */
export function bookingDetails(n: BookingDetailsSource, locale: TemplateLocale): BookingDetails {
  const c = bookingDetailsCopy(locale);
  const answers: DetailLine[] = [];
  for (const a of n.answers ?? []) {
    const value = readableAnswer(a, locale);
    if (value) answers.push({ label: cleanLine(a.label), value });
  }
  const notes = cleanBlock(String(n.attendee.notes ?? ''));
  if (notes) answers.push({ label: c.notes, value: clip(notes) });
  return {
    guest: {
      name: cleanLine(n.attendee.name),
      email: cleanLine(n.attendee.email),
      phone: cleanLine(n.attendee.phone),
    },
    others: (n.guests ?? []).filter((g) => cleanLine(g.email)).map(guestDisplay),
    answers,
  };
}

/** "Label: value", or "Question? value" when the label already ends a sentence. */
function textLine(label: string, value: string): string {
  const sep = /[?:!.]$/.test(label) ? ' ' : ': ';
  // A multi-line answer keeps its lines, indented under the first so the
  // next label still starts the line.
  return `${label}${sep}${value.split('\n').join('\n  ')}`;
}

/**
 * The block as plain text for the host's copy, appended under the template's
 * own body. `actionUrl` is where the host confirms or declines (a request only).
 */
export function bookingDetailsText(
  d: BookingDetails,
  locale: TemplateLocale,
  actionUrl?: string | null,
): string {
  const c = bookingDetailsCopy(locale);
  const who: string[] = [c.guestDetails];
  if (d.guest.name) who.push(textLine(c.name, d.guest.name));
  if (d.guest.email) who.push(textLine(c.email, d.guest.email));
  if (d.guest.phone) who.push(textLine(c.phone, d.guest.phone));
  if (d.others.length > 0) who.push(textLine(c.others, d.others.join(', ')));
  const sections = [who.join('\n')];
  if (d.answers.length > 0) {
    sections.push([c.answers, ...d.answers.map((a) => textLine(a.label, a.value))].join('\n'));
  }
  if (actionUrl) sections.push(`${c.act}: ${actionUrl}`);
  return sections.join('\n\n');
}
