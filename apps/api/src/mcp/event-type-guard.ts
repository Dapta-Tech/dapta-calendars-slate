import { createHash } from 'node:crypto';
import { isReservedFieldName, phoneValidator } from '@slate/shared';
import type { CrmPropertyMappings } from '@slate/types';

/**
 * What an agent may write into an event type over MCP, checked before any
 * write (ADR 0013). Pure: no I/O, so every rule has a row in its spec.
 *
 * The text an agent writes lands on a public booking page, in emails and on
 * calendars, so it carries no link or web address (a prompt-injected agent
 * could otherwise point invitees anywhere; mail and calendar apps link a bare
 * `name.com` by themselves) and no character a person cannot see (the usual
 * carrier of hidden instructions). Questions keep to what the booking page
 * renders well and the CRM can still read.
 */

export const MAX_QUESTIONS = 30;
export const MAX_OPTIONS = 50;
export const MAX_OPTION_LENGTH = 200;
/** A new question's name: what answers are keyed by, in webhooks and the CRM. */
export const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Question types an agent may use: every type but `guests`, which adds invitee-chosen emails to the invitation. */
export const MCP_QUESTION_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'checkbox'] as const;

export interface QuestionEdit {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

export interface EventTypeEdit {
  title?: string;
  description?: string | null;
  location?: { kind: string; detail?: string | null } | null;
  questions?: QuestionEdit[];
}

/** What the guard knows about the event type an edit lands on. */
export interface GuardContext {
  /** Names the event type already uses: they may keep a shape the dashboard allowed before these rules. */
  existingQuestionNames: readonly string[];
  /** Names of the questions the tools keep as they are (type guests): taken. */
  keptNames?: readonly string[];
  /** Fields that hold the host's own stored text, sent back unchanged: not checked again. */
  trusted?: ReadonlySet<string>;
}

export interface GuardProblem {
  code: 'URL_NOT_ALLOWED' | 'CHARACTERS_NOT_ALLOWED' | 'INVALID_ARGUMENT' | 'CRM_MAPPED_QUESTION';
  /** Where, in the tool's own argument names: `questions[2].options[0]`. */
  field: string;
  message: string;
}

/**
 * A link, however it is spelled, once the text is NFKC-normalized (fullwidth
 * letters read as plain ones) and lowercased: anything with `://` or `:\\`, a
 * host after `//` or `\\`, `www.` anywhere, or a scheme a client still opens
 * without slashes, directly followed by something (`javascript:alert(1)`).
 */
const LINK = /:(?:\/\/|\\\\)|(?:\/\/|\\\\)[\p{L}\p{N}]|www\./u;
const SCHEME = /(?<![a-z])(?:https?|javascript|data|vbscript|file|mailto):\S/;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;
/** A host name and what follows it: labels of letters, digits and `-`, then its top-level part. */
const HOST = /(?<![\p{L}\p{N}.-])(?:[a-z0-9-]+\.)+([a-z][a-z0-9-]*)(?![\p{L}\p{N}-])(\/)?/gu;
/** Top-level domains that mail and calendar apps turn into links on their own (`Next.js` and `e.g.` stay text). */
const LINKED_TLDS = new Set(
  'com net org io co ai app dev me ly gl gg to tv cc xyz info biz us uk es mx br ar cl pe ec ve de fr it nl ru cn in link site online store shop tech page live click top'.split(
    ' ',
  ),
);

/** Line breaks and tabs: only a description may have them. */
const LINE_BREAK = /[\t\n\r]/g;
/** A joiner between two emoji (a family, a profession at work): the one invisible character an agent may write. */
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)\u200D(?=\p{Extended_Pictographic})/gu;
/** Controls, format characters (bidi, zero-width, tags), private use, line and paragraph separators, and the blanks that show nothing. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}\u034F\u115F\u1160\u3164\uFFA0\u2800]/u;
/** Variation selectors can spell text a model reads; U+FE0E and U+FE0F (text or emoji style) stay. */
const SELECTOR = /(?![\uFE0E\uFE0F])\p{Variation_Selector}/u;

export function containsUrl(text: string): boolean {
  const t = text.normalize('NFKC').toLowerCase();
  if (LINK.test(t) || SCHEME.test(t) || IPV4.test(t)) return true;
  for (const [, tld, path] of t.matchAll(HOST)) if (path || LINKED_TLDS.has(tld!) || tld!.startsWith('xn--')) return true;
  return false;
}

function hasHiddenCharacters(value: string, lineBreaks: boolean): boolean {
  let rest = value.replace(EMOJI_JOINER, '');
  if (lineBreaks) rest = rest.replace(LINE_BREAK, '');
  return INVISIBLE.test(rest) || SELECTOR.test(rest);
}

function problem(code: GuardProblem['code'], field: string, message: string): GuardProblem {
  return { code, field, message };
}

/**
 * One text value: no hidden characters, no line breaks unless allowed, no
 * link. A field in `trusted` holds the host's own stored text, sent back
 * unchanged, and is not checked again.
 */
function checkText(value: string | null | undefined, field: string, ctx: GuardContext, lineBreaks = false): GuardProblem | null {
  if (!value || ctx.trusted?.has(field)) return null;
  if (hasHiddenCharacters(value, lineBreaks))
    return problem('CHARACTERS_NOT_ALLOWED', field, `${field} has a control, invisible or direction character${lineBreaks ? '' : ' or a line break'}.`);
  if (containsUrl(value)) return problem('URL_NOT_ALLOWED', field, `${field} has a link or a web address; links are not accepted over MCP.`);
  return null;
}

function checkLocation(location: NonNullable<EventTypeEdit['location']>, ctx: GuardContext): GuardProblem | null {
  const detail = location.detail?.trim() ?? '';
  if (location.kind === 'conferencing')
    return detail ? problem('INVALID_ARGUMENT', 'location.detail', 'A conferencing location takes no detail: the calendar makes the meeting link.') : null;
  const text = checkText(location.detail, 'location.detail', ctx);
  if (text || location.kind !== 'phone') return text;
  return !detail || phoneValidator(detail)
    ? problem('INVALID_ARGUMENT', 'location.detail', 'A phone location needs a phone number, such as +57 300 123 4567.')
    : null;
}

function checkQuestion(q: QuestionEdit, at: string, seen: Set<string>, ctx: GuardContext): GuardProblem | null {
  if (!QUESTION_NAME.test(q.name) && !ctx.existingQuestionNames.includes(q.name))
    return problem('INVALID_ARGUMENT', `${at}.name`, 'A new question name is lowercase letters, digits and _, starting with a letter (64 at most).');
  if (isReservedFieldName(q.name))
    return problem('INVALID_ARGUMENT', `${at}.name`, `"${q.name}" is asked by the booking page itself; use another name.`);
  if (ctx.keptNames?.includes(q.name))
    return problem('INVALID_ARGUMENT', `${at}.name`, `"${q.name}" is the name of a guests question, which stays as it is; use another name.`);
  if (seen.has(q.name)) return problem('INVALID_ARGUMENT', `${at}.name`, `Two questions are named "${q.name}".`);
  seen.add(q.name);
  const text = checkText(q.label, `${at}.label`, ctx) ?? checkText(q.placeholder, `${at}.placeholder`, ctx);
  if (text) return text;
  if (q.type !== 'select' && q.type !== 'checkbox') return null;
  const options = q.options ?? [];
  if (options.length === 0 || options.length > MAX_OPTIONS)
    return problem('INVALID_ARGUMENT', `${at}.options`, `A ${q.type} question needs 1 to ${MAX_OPTIONS} options.`);
  for (const [j, option] of options.entries()) {
    if (option.length > MAX_OPTION_LENGTH)
      return problem('INVALID_ARGUMENT', `${at}.options[${j}]`, `An option is ${MAX_OPTION_LENGTH} characters at most.`);
    const bad = checkText(option, `${at}.options[${j}]`, ctx);
    if (bad) return bad;
  }
  return null;
}

/** The first problem with an edit, or null. */
export function checkEventTypeEdit(edit: EventTypeEdit, ctx: GuardContext): GuardProblem | null {
  const text = checkText(edit.title, 'title', ctx) ?? checkText(edit.description, 'description', ctx, true);
  if (text) return text;
  if (edit.location) {
    const bad = checkLocation(edit.location, ctx);
    if (bad) return bad;
  }
  if (!edit.questions) return null;
  if (edit.questions.length > MAX_QUESTIONS)
    return problem('INVALID_ARGUMENT', 'questions', `At most ${MAX_QUESTIONS} questions.`);
  const seen = new Set<string>();
  for (const [i, q] of edit.questions.entries()) {
    const bad = checkQuestion(q, `questions[${i}]`, seen, ctx);
    if (bad) return bad;
  }
  return null;
}

/**
 * A question the CRM mapping reads keeps its name and type: an agent cannot
 * see or repair the mapping, so removing, renaming or retyping that question
 * would quietly stop the CRM from receiving its answer.
 */
export function mappedQuestionProblem(
  mappings: CrmPropertyMappings | null | undefined,
  before: ReadonlyArray<{ name?: unknown; type?: unknown }>,
  after: ReadonlyArray<{ name?: unknown; type?: unknown }>,
): GuardProblem | null {
  const mapped = Object.values(mappings ?? {})
    .flat()
    .flatMap((row) => (row.source.kind === 'question' ? [row.source.name] : []));
  for (const name of new Set(mapped)) {
    const was = before.find((q) => q.name === name);
    if (!was) continue;
    if (after.some((q) => q.name === name && q.type === was.type)) continue;
    return problem(
      'CRM_MAPPED_QUESTION',
      'questions',
      `The CRM mapping reads the question "${name}", so it stays with the same name and type; change the mapping in the dashboard first.`,
    );
  }
  return null;
}

/** A URL path segment from a title: `Café con Leche!` is `cafe-con-leche`. */
export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'event';
}

/** The fields an agent may edit, as the event type stores them. */
export interface RevisionFields {
  title: string;
  description: string | null;
  lengthMinutes: number;
  location: unknown;
  bookingFields: unknown;
  hidden: boolean;
  minimumBookingNotice: number;
  requiresConfirmation: boolean;
  bookingWindowDays: number | null;
}

/** JSON with every object's keys sorted, so a stored value reads the same on both dialects. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * A fingerprint of the editable fields: it changes whenever any of them does,
 * whoever changed it. `update_event_type` compares it with `if_revision`, so a
 * question list replaced over MCP is always one the agent has seen.
 */
export function eventTypeRevision(f: RevisionFields): string {
  const fields = [
    f.title,
    f.description ?? null,
    f.lengthMinutes,
    f.location ?? null,
    f.bookingFields ?? [],
    f.hidden,
    f.minimumBookingNotice,
    f.requiresConfirmation,
    f.bookingWindowDays ?? null,
  ];
  return createHash('sha256').update(canonical(fields)).digest('hex').slice(0, 16);
}
