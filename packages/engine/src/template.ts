/**
 * The template engine: one logic-less, single-pass renderer for every text a
 * host writes that is sent or shown to someone (the calendar event title and
 * body, email subjects and bodies).
 *
 * Grammar, a superset of the `{{variable}}` email templates that shipped first:
 *
 *   {{attendee_name}}                     a value (catalog name, alias or form.<question>)
 *   {{attendee_first_name | "there"}}     a value with a fallback for when it is empty
 *   {{#if form.company}}...{{/if}}        text shown only when the value is non-empty
 *   {{#if form.plan == "Pro"}}...{{else}}...{{/if}}   equality (also != and contains)
 *
 * Safe by construction:
 *   - there is no expression language: a condition is one name, optionally
 *     compared to one quoted literal; there are no loops, helpers or raw output;
 *   - rendering is SINGLE PASS: a value is copied into the output and never
 *     parsed again, so an answer that contains `{{attendee_email}}` prints those
 *     characters, it does not expand them;
 *   - names are looked up as own properties of the values map only, so
 *     `{{__proto__}}` or `{{constructor}}` can never reach Object.prototype;
 *   - every value is cleaned (control and bidi characters removed, line breaks
 *     folded in single-line mode) and length-capped before it is inserted;
 *   - the output is PLAIN TEXT. Each sink encodes the finished text for its own
 *     format (HTML escaping for email HTML, RFC 5545 for ICS); no host-authored
 *     markup ever reaches a recipient.
 *
 * Fail closed at save (`validateTemplate` refuses unknown names and broken
 * blocks), fail soft at render: a stored template that no longer validates
 * still renders (an unknown name is empty, a malformed tag prints as written),
 * because a template must never block a booking or an email.
 */
import {
  FORM_FIELD_NAME_RE,
  FORM_VARIABLE_PREFIX,
  canonicalVariable,
  isFormVariable,
  templateVariable,
  type TemplateAudience,
  type TemplateContext,
  type TemplateLocale,
} from './template-catalog';

export * from './template-catalog';

/* ------------------------------------------------------------------------ *
 * AST                                                                      *
 * ------------------------------------------------------------------------ */

export interface TemplateCondition {
  name: string;
  op: 'present' | 'eq' | 'ne' | 'contains';
  /** The literal compared against, for `eq`, `ne` and `contains`. */
  value?: string;
}

export type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string; fallback: string | null; start: number; end: number; raw: string }
  | {
      type: 'if';
      cond: TemplateCondition;
      then: TemplateNode[];
      otherwise: TemplateNode[];
      /** The opening tag shares its line with other text (not standalone). */
      inline: boolean;
      start: number;
      end: number;
      raw: string;
    };

export type TemplateIssueCode =
  | 'unknown_variable'
  | 'unknown_question'
  | 'not_available'
  | 'host_only'
  | 'per_invitee'
  | 'bad_tag'
  | 'unclosed_tag'
  | 'unclosed_block'
  | 'stray_close'
  | 'stray_else'
  | 'duplicate_else'
  | 'too_deep'
  | 'bad_literal';

export interface TemplateIssue {
  code: TemplateIssueCode;
  /** Errors block a save; warnings are shown and allowed. */
  severity: 'error' | 'warning';
  /** The tag as written, e.g. `{{form.budjet}}`. */
  token: string;
  /** Offsets into the template text (for highlighting). */
  start: number;
  end: number;
}

export interface ParsedTemplate {
  nodes: TemplateNode[];
  issues: TemplateIssue[];
}

/** Blocks nest at most this deep; deeper is a save-time error. */
export const MAX_TEMPLATE_DEPTH = 3;
/** The longest quoted literal (fallback or comparison value). */
export const MAX_TEMPLATE_LITERAL = 100;

/* ------------------------------------------------------------------------ *
 * Parser                                                                   *
 * ------------------------------------------------------------------------ */

// The built-in half is the first email renderer's own charset, so a stored
// template reads the same: `{{__proto__}}` or a long unknown name resolves
// empty, `{{abc1}}` stays text. No catalog name has a digit.
const NAME = String.raw`(?:[a-z_]+|form\.[A-Za-z0-9_]{1,64})`;
// Straight double, straight single and typographic double quotes (an OS
// autocorrect can turn one into the other while a host types).
const LITERAL = String.raw`(?:"([^"\r\n]*)"|'([^'\r\n]*)'|“([^”\r\n]*)”)`;
// A fallback is `| "text"`; `| default: "text"` (the Liquid spelling) is accepted too.
const VAR_TAG = new RegExp(String.raw`^(${NAME})(?:\s*\|\s*(?:default\s*:\s*)?${LITERAL})?$`);
const IF_TAG = new RegExp(String.raw`^#if\s+(${NAME})(?:\s*(==|!=|\bcontains\b)\s*${LITERAL})?$`);
const ELSE_TAG = /^else$/;
const CLOSE_TAG = /^\/if$/;

function literalOf(m: RegExpExecArray, from: number): string | null {
  for (let i = from; i < from + 3; i += 1) if (m[i] !== undefined) return m[i]!;
  return null;
}

type Tag =
  | { kind: 'var'; name: string; fallback: string | null }
  | { kind: 'if'; cond: TemplateCondition }
  | { kind: 'else' }
  | { kind: 'close' };

function readTag(inner: string): Tag | null {
  // A tag is on one line; the first renderer matched body lines one at a time.
  if (/[\r\n]/.test(inner)) return null;
  const body = inner.trim();
  // `else` would also read as a variable name, so the block words go first.
  if (ELSE_TAG.test(body)) return { kind: 'else' };
  if (CLOSE_TAG.test(body)) return { kind: 'close' };
  let m = VAR_TAG.exec(body);
  if (m) return { kind: 'var', name: canonicalVariable(m[1]!), fallback: literalOf(m, 2) };
  m = IF_TAG.exec(body);
  if (m) {
    const name = canonicalVariable(m[1]!);
    if (!m[2]) return { kind: 'if', cond: { name, op: 'present' } };
    const op = m[2] === '==' ? 'eq' : m[2] === '!=' ? 'ne' : 'contains';
    return { kind: 'if', cond: { name, op, value: literalOf(m, 3) ?? '' } };
  }
  return null;
}

interface Frame {
  node: Extract<TemplateNode, { type: 'if' }>;
  inElse: boolean;
}

type Token =
  | { t: 'text'; value: string }
  | { t: 'tag'; tag: Tag; raw: string; start: number; end: number; standalone?: boolean };

/** Split the text into literal runs and recognized tags (positions are offsets into `text`). */
function tokenize(text: string, issues: TemplateIssue[]): Token[] {
  const tokens: Token[] = [];
  const pushText = (value: string): void => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.t === 'text') last.value += value;
    else tokens.push({ t: 'text', value });
  };
  let i = 0;
  // The first `}}` at or after a position stays the same until the scan passes
  // it, so it is found once, not once per `{{` (keeps `{{{{...}}` linear).
  let close = -1;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open === -1) {
      pushText(text.slice(i));
      break;
    }
    pushText(text.slice(i, open));
    if (close < open + 2) close = text.indexOf('}}', open + 2);
    if (close === -1) {
      issues.push(issue('unclosed_tag', text.slice(open, Math.min(text.length, open + 24)), open, text.length));
      pushText(text.slice(open));
      break;
    }
    // Another `{{` before the close (`{{{name}}}`, `{{ a {{b}}`): this one is
    // not a tag. Keep the text up to the next opening and rescan from there,
    // the way the first email renderer's regex did.
    const next = text.indexOf('{{', open + 1);
    if (next !== -1 && next < close) {
      pushText(text.slice(open, next));
      i = next;
      continue;
    }
    const raw = text.slice(open, close + 2);
    const tag = readTag(text.slice(open + 2, close));
    if (!tag) {
      // Not a tag: keep one brace as text and rescan from the next character.
      issues.push(issue('bad_tag', raw, open, close + 2));
      pushText('{');
      i = open + 1;
      continue;
    }
    tokens.push({ t: 'tag', tag, raw, start: open, end: close + 2 });
    i = close + 2;
  }
  return tokens;
}

/**
 * Blocks that cannot pair up render as the text they are, the way the first
 * email renderer printed any `{{#if ...}}` it could not read: an unclosed
 * `{{#if}}` and a stray `{{/if}}` print as written, so a broken block never
 * hides the rest of a message. A stray `{{else}}` renders empty, as that
 * renderer treated every lowercase name it did not know. Each is still an
 * error for `validateTemplate`.
 */
function pairBlocks(tokens: readonly Token[], issues: TemplateIssue[]): Token[] {
  const literal = new Set<number>();
  const empty = new Set<number>();
  // First the opens no close ever pairs with: a close always pairs with the
  // nearest open still waiting, so taking those out moves no other pair.
  const waiting: number[] = [];
  tokens.forEach((tok, n) => {
    if (tok.t !== 'tag') return;
    if (tok.tag.kind === 'if') waiting.push(n);
    else if (tok.tag.kind === 'close' && waiting.pop() === undefined) {
      issues.push(issue('stray_close', tok.raw, tok.start, tok.end));
      literal.add(n);
    }
  });
  for (const n of waiting) {
    const tok = tokens[n] as Extract<Token, { t: 'tag' }>;
    issues.push(issue('unclosed_block', tok.raw, tok.start, tok.end));
    literal.add(n);
  }
  // Then an `{{else}}` outside every block that is left.
  let depth = 0;
  tokens.forEach((tok, n) => {
    if (tok.t !== 'tag' || literal.has(n)) return;
    if (tok.tag.kind === 'if') depth += 1;
    else if (tok.tag.kind === 'close') depth -= 1;
    else if (tok.tag.kind === 'else' && depth === 0) {
      issues.push(issue('stray_else', tok.raw, tok.start, tok.end));
      empty.add(n);
    }
  });
  const out: Token[] = [];
  tokens.forEach((tok, n) => {
    const last = out[out.length - 1];
    const text = tok.t === 'text' ? tok.value : literal.has(n) ? tok.raw : null;
    if (text !== null) {
      if (last && last.t === 'text') last.value += text;
      else out.push({ t: 'text', value: text });
    } else if (empty.has(n) && tok.t === 'tag') {
      // An empty name is the one that never resolves (and is never reported twice).
      out.push({ ...tok, tag: { kind: 'var', name: '', fallback: null } });
    } else out.push(tok);
  });
  return out;
}

/**
 * Mustache's "standalone tag" rule: a line holding nothing but one block tag
 * disappears with its line break, so
 *
 *   Hi,\n{{#if form.company}}\nCompany: x\n{{/if}}\nThanks
 *
 * renders as three lines, not five. Only the whitespace around the tag is
 * trimmed, so every offset still points into the text as written.
 */
function applyStandalone(tokens: Token[]): void {
  // Text runs that begin a line because the tag before them already took its
  // line break (two standalone tags in a row).
  const startsLine = new Set<Token>();
  for (let n = 0; n < tokens.length; n += 1) {
    const tok = tokens[n]!;
    if (tok.t !== 'tag' || tok.tag.kind === 'var') continue;
    const prev = tokens[n - 1];
    const next = tokens[n + 1];
    const before = prev === undefined ? '' : prev.t === 'text' ? prev.value : null;
    const after = next === undefined ? '' : next.t === 'text' ? next.value : null;
    if (before === null || after === null) continue;
    const lead = /(^|\n)[ \t]*$/.exec(before);
    const trail = /^[ \t]*(\r?\n|$)/.exec(after);
    if (!lead || !trail) continue;
    // `^` and `$` only mean "line start/end" at the true edges of the text: a
    // run that begins right after a variable (`{{name}} {{#if x}}`) is mid-line.
    if (lead[1] === '' && n - 1 > 0 && !(prev && startsLine.has(prev))) continue;
    if (trail[1] === '' && n + 1 < tokens.length - 1) continue;
    // A tag at the very start AND end of the text is a template that is only a
    // tag: nothing to tidy.
    if (prev === undefined && next === undefined) continue;
    if (prev && prev.t === 'text') prev.value = before.slice(0, lead.index + lead[1]!.length);
    if (next && next.t === 'text') {
      next.value = after.slice(trail[0].length);
      startsLine.add(next);
    }
    tok.standalone = true;
  }
}

/**
 * Parse a template into nodes plus syntax issues. Never throws: a tag that
 * does not parse stays literal text (exactly how the original email renderer
 * treated `{{Name}}`), and so does a block that does not pair up.
 */
export function parseTemplate(text: string): ParsedTemplate {
  const issues: TemplateIssue[] = [];
  const tokens = pairBlocks(tokenize(text, issues), issues);
  applyStandalone(tokens);

  const root: TemplateNode[] = [];
  const stack: Frame[] = [];
  const target = (): TemplateNode[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.node.otherwise : top.node.then;
  };
  for (const tok of tokens) {
    if (tok.t === 'text') {
      if (!tok.value) continue;
      const list = target();
      const last = list[list.length - 1];
      if (last && last.type === 'text') last.value += tok.value;
      else list.push({ type: 'text', value: tok.value });
      continue;
    }
    const { tag, raw, start, end } = tok;
    if (tag.kind === 'var') {
      if (tag.fallback !== null && tag.fallback.length > MAX_TEMPLATE_LITERAL) {
        issues.push(issue('bad_literal', raw, start, end));
      }
      target().push({ type: 'var', name: tag.name, fallback: tag.fallback, start, end, raw });
    } else if (tag.kind === 'if') {
      if (tag.cond.value !== undefined && tag.cond.value.length > MAX_TEMPLATE_LITERAL) {
        issues.push(issue('bad_literal', raw, start, end));
      }
      if (stack.length >= MAX_TEMPLATE_DEPTH) issues.push(issue('too_deep', raw, start, end));
      const node: Extract<TemplateNode, { type: 'if' }> = {
        type: 'if',
        cond: tag.cond,
        then: [],
        otherwise: [],
        inline: !tok.standalone,
        start,
        end,
        raw,
      };
      target().push(node);
      stack.push({ node, inElse: false });
    } else if (tag.kind === 'else') {
      // `pairBlocks` has made every remaining `{{else}}` sit inside a block.
      const top = stack[stack.length - 1]!;
      if (top.inElse) issues.push(issue('duplicate_else', raw, start, end));
      else top.inElse = true;
    } else {
      stack.pop();
    }
  }
  return { nodes: root, issues };
}

function issue(code: TemplateIssueCode, token: string, start: number, end: number): TemplateIssue {
  return { code, severity: code === 'unknown_question' ? 'warning' : 'error', token, start, end };
}

/* ------------------------------------------------------------------------ *
 * Validation                                                               *
 * ------------------------------------------------------------------------ */

export interface ValidateOptions {
  context: TemplateContext;
  /**
   * Who reads the text. A host-only variable (`guests`) is refused unless it
   * is `host`, so an omitted audience fails safe.
   */
  audience?: TemplateAudience;
  /**
   * The text is shared by everyone on a seated event's slot (its calendar
   * title and description). One invitee's data (`perInvitee` variables and
   * every answer) is refused, since each seat-taker would read it.
   */
  seated?: boolean;
  /**
   * The event type's question names. Given: `{{form.x}}` for a question the
   * event does not ask is a WARNING (questions can be renamed or removed after
   * a template is written, and old bookings keep their old answers). Omitted
   * (an account-wide email template, which has no event): any well-formed
   * question name is accepted.
   */
  questions?: readonly string[];
}

/** Every problem in a template: syntax, unknown names, names not available in this context. */
export function validateTemplate(text: string, opts: ValidateOptions): TemplateIssue[] {
  const parsed = parseTemplate(text);
  const issues = [...parsed.issues];
  const questions = opts.questions ? new Set(opts.questions) : null;
  const check = (name: string, raw: string, start: number, end: number): void => {
    if (name === '') return; // a stray `{{else}}`, already reported by the parser
    if (isFormVariable(name)) {
      const field = name.slice(FORM_VARIABLE_PREFIX.length);
      if (!FORM_FIELD_NAME_RE.test(field)) issues.push(issue('bad_tag', raw, start, end));
      else if (opts.seated) issues.push(issue('per_invitee', raw, start, end));
      else if (questions && !questions.has(field)) issues.push(issue('unknown_question', raw, start, end));
      return;
    }
    const def = templateVariable(name);
    if (!def) issues.push(issue('unknown_variable', raw, start, end));
    else if (!def.contexts.includes(opts.context)) issues.push(issue('not_available', raw, start, end));
    else if (def.hostOnly && opts.audience !== 'host') issues.push(issue('host_only', raw, start, end));
    else if (def.perInvitee && opts.seated) issues.push(issue('per_invitee', raw, start, end));
  };
  walk(parsed.nodes, (node) => {
    if (node.type === 'var') check(node.name, node.raw, node.start, node.end);
    else if (node.type === 'if') check(node.cond.name, node.raw, node.start, node.end);
  });
  return issues.sort((a, b) => a.start - b.start);
}

/** Only the issues that block a save. */
export function templateErrors(text: string, opts: ValidateOptions): TemplateIssue[] {
  return validateTemplate(text, opts).filter((i) => i.severity === 'error');
}

/** Every variable name a template reads (canonical names, `form.*` included). */
export function templateVariableNames(text: string): string[] {
  const names = new Set<string>();
  walk(parseTemplate(text).nodes, (node) => {
    if (node.type === 'var' && node.name !== '') names.add(node.name);
    else if (node.type === 'if') names.add(node.cond.name);
  });
  return [...names];
}

function walk(nodes: readonly TemplateNode[], visit: (node: TemplateNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.type === 'if') {
      walk(node.then, visit);
      walk(node.otherwise, visit);
    }
  }
}

const MESSAGES: Record<TemplateIssueCode, Record<TemplateLocale, string>> = {
  unknown_variable: {
    en: '{token} is not a variable. Pick one from the list.',
    es: '{token} no es una variable. Elige una de la lista.',
  },
  unknown_question: {
    en: '{token} is not a question in this event, so it will be empty.',
    es: '{token} no es una pregunta de este evento, así que quedará vacío.',
  },
  not_available: {
    en: '{token} is not available here.',
    es: '{token} no está disponible aquí.',
  },
  host_only: {
    en: "{token} is only available in the host's copy.",
    es: '{token} solo está disponible en la copia del anfitrión.',
  },
  per_invitee: {
    en: "{token} is one invitee's data, and everyone who takes a seat sees this event.",
    es: '{token} es un dato de un solo invitado, y todos los que reservan un cupo ven este evento.',
  },
  bad_tag: {
    en: '{token} is not valid. Variables look like {{attendee_name}}.',
    es: '{token} no es válido. Las variables se escriben así: {{attendee_name}}.',
  },
  unclosed_tag: {
    en: '{token} is missing its closing }}.',
    es: 'A {token} le falta el cierre }}.',
  },
  unclosed_block: {
    en: '{token} needs a matching {{/if}}.',
    es: '{token} necesita su {{/if}}.',
  },
  stray_close: {
    en: '{token} has no matching {{#if ...}}.',
    es: '{token} no tiene un {{#if ...}} que cerrar.',
  },
  stray_else: {
    en: '{token} must be inside a {{#if ...}} block.',
    es: '{token} debe ir dentro de un bloque {{#if ...}}.',
  },
  duplicate_else: {
    en: 'A block can have only one {{else}}.',
    es: 'Un bloque solo puede tener un {{else}}.',
  },
  too_deep: {
    en: '{token} nests too deep (at most 3 levels).',
    es: '{token} está anidado demasiado (máximo 3 niveles).',
  },
  bad_literal: {
    en: 'The quoted text in {token} is too long (at most 100 characters).',
    es: 'El texto entre comillas de {token} es muy largo (máximo 100 caracteres).',
  },
};

/** A plain-language message for one issue. */
export function templateIssueMessage(i: Pick<TemplateIssue, 'code' | 'token'>, locale: TemplateLocale = 'en'): string {
  // A function, so a `$` in the token is never read as a replacement pattern.
  return MESSAGES[i.code][locale].replace('{token}', () => i.token);
}

/* ------------------------------------------------------------------------ *
 * Rendering                                                                *
 * ------------------------------------------------------------------------ */

/** A value as the renderer accepts it: answers can be booleans or lists. */
export type TemplateScalar = string | number | boolean;
export type TemplateValue = TemplateScalar | readonly TemplateScalar[] | null | undefined;
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

export type RenderMode = 'line' | 'text';

export interface RenderOptions {
  /**
   * `line`: one line (titles, subjects). Line breaks and tabs in values become
   * spaces and the result collapses whitespace, so no value can start a new
   * header or title line. `text`: multi-line bodies, with the empty-line rule.
   */
  mode: RenderMode;
  /** Language for yes/no answers. */
  locale?: TemplateLocale;
  /** Cap on the whole rendered text (an ellipsis marks a cut). */
  maxLength?: number;
  /** Cap on each inserted value. Defaults: 200 (line), 2000 (text: the longest answer or reason a visitor can send). */
  maxValueLength?: number;
  /**
   * Remove `<` and `>` from values. For sinks that may treat text as HTML
   * downstream (calendar providers render some markup in descriptions), so a
   * visitor's answer can never become a link or a tag there.
   */
  stripAngleBrackets?: boolean;
}

// C0 and C1 controls except tab/LF/CR (handled per mode), the bidi embedding,
// override and isolate controls, the LRM, RLM and Arabic letter marks, and the
// characters that print as nothing (soft hyphen, zero-width space, word joiner,
// invisible operators, fillers, the braille blank, BOM, and the tag characters
// that can carry hidden text): the classic ways to make rendered text read
// differently from what was typed. The zero-width joiner and non-joiner stay,
// since emoji and several scripts need them.
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;

/** `text` without the characters above (line breaks and tabs kept). */
export function stripUnsafeText(text: string): string {
  return text.replace(UNSAFE_CHARS, '');
}

/** The default cap on one inserted value, per mode (see `RenderOptions`). */
export const MAX_TEMPLATE_VALUE: Readonly<Record<RenderMode, number>> = { line: 200, text: 2000 };

/** Cut `value` to `max` characters, an ellipsis marking the cut (never inside an emoji). */
export function capTemplateText(value: string, max: number): string {
  return cap(value, max);
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = Math.max(0, max - 1);
  // Never cut between the two halves of an emoji or another astral character.
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut).trimEnd()}…`;
}

/** One value as text: lists joined, booleans as Yes/No in the reader's language. */
export function formatTemplateValue(value: TemplateValue, locale: TemplateLocale = 'en'): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? (locale === 'es' ? 'Sí' : 'Yes') : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((x: unknown) => (typeof x === 'object' ? '' : formatTemplateValue(x as TemplateScalar, locale).trim()))
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

/** Locale-aware "Sat, Aug 1, 11:00 AM EDT" in `timeZone`; the ISO text itself when the zone is unreadable. */
export function formatTemplateTime(iso: string, timeZone: string, locale: TemplateLocale = 'en'): string {
  try {
    return new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en-US', {
      timeZone,
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

/** "30 min", "1 h", "1 h 30 min": the meeting length, the same in EN and ES. */
export function formatTemplateDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The first word of a name: what `{{attendee_first_name}}` reads. */
export function templateFirstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/**
 * The most items of one list answer a template reads (the email's answer list
 * shows as many). The public booking request does not bound an answer, so a
 * huge one is cut before it is formatted or compared, never after.
 */
export const MAX_TEMPLATE_LIST_ITEMS = 50;

/**
 * One intake answer as the engine reads it. Text, numbers and yes/no stay as
 * they are and lists keep their items, so the engine can word a boolean in the
 * reader's language and test a list item by item. Anything else (an object, a
 * nested list) is not an answer a form produces and reads as empty. Text is cut
 * to the longest value a template prints, and a list to its first items.
 */
function answerValue(value: unknown): TemplateValue {
  if (typeof value === 'string') return value.slice(0, MAX_TEMPLATE_VALUE.text);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .filter(
        (v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      )
      .slice(0, MAX_TEMPLATE_LIST_ITEMS)
      .map((v) => (typeof v === 'string' ? v.slice(0, MAX_TEMPLATE_VALUE.text) : v));
  }
  return null;
}


/**
 * The `{{form.<question name>}}` half of a values map, from a booking's
 * answers. Own properties only, and every key is `form.`-prefixed, so an
 * answer can never collide with a built-in. With `questions`, only the answers
 * to those questions: the public booking request accepts any answer key, and
 * one the event never asked must not print under the host's name.
 */
export function templateFormValues(
  answers: Readonly<Record<string, unknown>> | null | undefined,
  questions?: readonly string[],
): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = Object.create(null) as Record<string, TemplateValue>;
  if (!answers) return out;
  const asked = questions ? new Set(questions) : null;
  for (const [name, value] of Object.entries(answers)) {
    if (asked && !asked.has(name)) continue;
    out[`${FORM_VARIABLE_PREFIX}${name}`] = answerValue(value);
  }
  return out;
}

/** Clean one value for insertion: control and bidi characters out, line breaks per mode, length capped. */
export function cleanTemplateValue(text: string, opts: Pick<RenderOptions, 'mode' | 'maxValueLength' | 'stripAngleBrackets'>): string {
  // The Unicode line and paragraph separators break a line for many readers:
  // they are line breaks here too, never a way to hide one.
  let out = text.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  if (opts.mode === 'line') out = out.replace(/[\n\t]+/g, ' ');
  out = out.replace(UNSAFE_CHARS, '');
  if (opts.stripAngleBrackets) out = out.replace(/[<>]/g, '');
  return cap(out, opts.maxValueLength ?? MAX_TEMPLATE_VALUE[opts.mode]);
}

function lookup(values: TemplateValues, name: string): TemplateValue {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function normalized(s: string): string {
  return s.normalize('NFC').trim().toLowerCase();
}

// A yes/no answer compares equal to the words a host would write for it.
const TRUE_WORDS = new Set(['true', 'yes', 'sí', 'si']);
const FALSE_WORDS = new Set(['false', 'no']);

function itemEquals(value: unknown, want: string): boolean {
  if (typeof value === 'boolean') return (value ? TRUE_WORDS : FALSE_WORDS).has(want);
  if (typeof value === 'object') return false;
  return normalized(formatTemplateValue(value as TemplateScalar)) === want;
}

function holds(cond: TemplateCondition, values: TemplateValues): boolean {
  const raw = lookup(values, cond.name);
  if (cond.op === 'present') {
    if (typeof raw === 'boolean') return raw;
    return formatTemplateValue(raw).trim() !== '';
  }
  const want = normalized(cond.value ?? '');
  if (cond.op === 'contains') {
    // A list contains an item; a text contains a phrase. Both ignore case.
    if (Array.isArray(raw)) return raw.some((x) => itemEquals(x, want));
    // A yes/no answer has no phrase in it: it contains only its own word.
    if (typeof raw === 'boolean') return itemEquals(raw, want);
    return want !== '' && normalized(formatTemplateValue(raw)).includes(want);
  }
  const equal = Array.isArray(raw) ? raw.some((x) => itemEquals(x, want)) : itemEquals(raw, want);
  return cond.op === 'eq' ? equal : !equal;
}

type Piece = { kind: 'lit' | 'val'; text: string } | { kind: 'block'; text: '' };

function emit(nodes: readonly TemplateNode[], values: TemplateValues, opts: RenderOptions, out: Piece[]): void {
  const locale = opts.locale ?? 'en';
  for (const node of nodes) {
    if (node.type === 'text') out.push({ kind: 'lit', text: node.value });
    else if (node.type === 'var') {
      let text = cleanTemplateValue(formatTemplateValue(lookup(values, node.name), locale), opts);
      if (text.trim() === '' && node.fallback !== null) text = cleanTemplateValue(node.fallback, opts);
      out.push({ kind: 'val', text });
    } else {
      // An inline block marks its line, so a line left blank by it drops.
      if (node.inline) out.push({ kind: 'block', text: '' });
      emit(holds(node.cond, values) ? node.then : node.otherwise, values, opts, out);
    }
  }
}

/**
 * Text mode's line rule (unchanged from the first email renderer): a template
 * line whose variables ALL came out empty is dropped, so "Where: {{location}}"
 * vanishes when there is no location. Line breaks INSIDE a value (a long-text
 * answer) do not split a template line; literal-only lines always stay. A line
 * that holds an inline block and nothing but blanks once rendered drops too,
 * so `{{#if form.company}}Company: {{form.company}}{{/if}}` on a line of its
 * own leaves no gap when there is no company.
 */
function joinLines(pieces: readonly Piece[]): string {
  const lines: string[] = [];
  let buf = '';
  let sawVar = false;
  let sawValue = false;
  let sawBlock = false;
  const flush = (): void => {
    const emptyVars = sawVar && !sawValue;
    const emptyBlock = sawBlock && buf.trim() === '';
    if (!emptyVars && !emptyBlock) lines.push(buf);
    buf = '';
    sawVar = false;
    sawValue = false;
    sawBlock = false;
  };
  for (const piece of pieces) {
    if (piece.kind === 'block') {
      sawBlock = true;
      continue;
    }
    if (piece.kind === 'val') {
      sawVar = true;
      if (piece.text !== '') sawValue = true;
      buf += piece.text;
      continue;
    }
    const parts = piece.text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) flush();
      buf += part;
    });
  }
  flush();
  return lines.join('\n');
}

/** Render a template (text or an already-parsed one) to plain text. Never throws. */
export function renderTemplate(template: string | ParsedTemplate, values: TemplateValues, opts: RenderOptions): string {
  const parsed = typeof template === 'string' ? parseTemplate(template) : template;
  const pieces: Piece[] = [];
  emit(parsed.nodes, values, opts, pieces);
  let out: string;
  if (opts.mode === 'line') {
    out = pieces
      .map((p) => p.text)
      .join('')
      .replace(/\s+/g, ' ');
  } else {
    // The host's own text is cleaned like a value: one line-break style (a
    // bare CR must never reach a mail transport) and no invisible controls.
    out = joinLines(pieces).replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  out = stripUnsafeText(out).trim();
  return opts.maxLength ? cap(out, opts.maxLength) : out;
}
