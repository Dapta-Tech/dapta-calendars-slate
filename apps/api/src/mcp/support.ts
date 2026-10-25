import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { hashApiValue } from '@slate/db';
import { zoneOffsetMinutes } from '@slate/shared';
import type { MachinePrincipal } from '../auth.service';
import type { ExternalLogin, LoginAccount } from '../oauth/external.service';
import { OAUTH_SCOPES } from '../oauth/oauth.settings';

/**
 * Shared plumbing for the MCP door: how a tool says "no", how untrusted text is
 * cleaned before it reaches a model, and how a call is described in the audit
 * line without the personal data in it.
 */

/** A failure a model can act on. Rendered as an `isError` tool result. */
export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }

  /** The text the model reads: stable code first, then what to do about it. */
  render(): string {
    const retry = this.retryAfterSeconds ? ` Retry after ${this.retryAfterSeconds}s.` : '';
    return `${this.code}: ${this.message}${this.hint ? ` ${this.hint}` : ''}${retry}`;
  }
}

/** What one request knows about who is calling and why. Built by the controller. */
export interface McpCall {
  requestId: string;
  protocolVersion: string;
  /** Client address (rate-limit key for anonymous calls). Never logged. */
  ip: string;
  /**
   * Null: no credential presented, only the public tools are callable; a
   * sign-in that reaches several accounts, until a tool call names one; or a
   * sign-in that reaches none, which may only call the public tools.
   */
  principal: MachinePrincipal | null;
  /**
   * A sign-in through an external authorization server: the verified token and
   * every account it may act in. With one account `principal` is already that
   * account's; with several the call picks one (`account_id`); with none every
   * tool that is not public answers NOT_LINKED.
   */
  login?: { token: ExternalLogin; accounts: LoginAccount[] };
}

/** `dcl_<8hex>`, `login:<8 chars>` or `anonymous`: the only identity that reaches a log line. */
export function callerLabel(call: McpCall): string {
  return call.principal?.prefix ?? (call.login ? 'login' : 'anonymous');
}

/**
 * Who a sign-in is while it has not picked an account (a public page tool
 * called by a sign-in reaching several): one key per person, so it never
 * shares the anonymous per-address bucket or idempotency namespace.
 */
export function signInKey(login: NonNullable<McpCall['login']>): string {
  return `login:${createHash('sha256').update(login.token.subject).digest('hex').slice(0, 32)}`;
}

/**
 * The principal of a sign-in acting in one account, as the member it is
 * there. An external server has no scopes of ours, so a sign-in holds every
 * MCP scope: it acts with the member's admin rights, checked on every request.
 * Narrow access (read-only, one event type) stays with scoped API keys.
 */
export function loginPrincipal(account: LoginAccount, token: ExternalLogin): MachinePrincipal {
  return {
    kind: 'oauth',
    keyId: `login:${account.memberId}`,
    prefix: `login:${account.memberId.slice(0, 8)}`,
    accountId: account.accountId,
    memberId: account.memberId,
    scopes: [...OAUTH_SCOPES],
    eventTypeIds: null,
    expiresAtMs: token.expiresAtMs,
    ...(token.clientId ? { clientId: token.clientId } : {}),
    ...(token.sessionId ? { sessionId: token.sessionId } : {}),
  };
}

/**
 * Who owns what a call leaves behind (an idempotency record, a hold): the key
 * or OAuth connection; a sign-in through an external server as the person
 * (`signInKey`), whichever account the call named, because the account is
 * already part of every namespace and `book_meeting`, which never names one,
 * must still find a hold made while naming it; or for an anonymous call a
 * digest of its address. Never logged; a namespace, not an identity.
 */
export function callerId(call: McpCall): string {
  if (call.login) return signInKey(call.login);
  return call.principal ? `key:${call.principal.keyId}` : `anon:${hashApiValue(call.ip)}`;
}

/**
 * Whether this connection may act in `accountId`: a key or connection in its
 * own account, a sign-in in any account it reaches, whichever one (if any) this
 * call named.
 */
export function reachesAccount(call: McpCall, accountId: string): boolean {
  if (call.login) return call.login.accounts.some((a) => a.accountId === accountId);
  return call.principal?.accountId === accountId;
}

/** Not found for everything out of reach: another tenant, outside the allowlist, or absent. */
export const notFound = (what: string): ToolFailure =>
  new ToolFailure('NOT_FOUND', `${what} not found.`, 'Check the identifier; it may belong to another workspace or be outside this key\'s event-type allowlist.');

// --- Untrusted text -------------------------------------------------------

/**
 * Zero-width and bidi-control characters: invisible to a person, and the usual
 * way to hide an instruction inside a name or a note.
 */
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u00AD]', 'g');
/** Unicode tag characters (hidden text a model still reads) and variation selectors. */
const HIDDEN_ASTRAL = /[\u{E0000}-\u{E007F}]|\p{Variation_Selector}/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');

/** A character that, right after `<`, opens markup: a letter, `!`, `/` or `?`. */
function opensTag(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 33 || code === 47 || code === 63;
}

/**
 * Removes markup in one linear pass, without a regex: a `<` that opens a tag goes
 * with the tag up to its `>` (or alone when nothing closes it), and a kept `<` is
 * dropped the moment a tag character would follow it in the output, so nested
 * input like `<<b>script>` cannot reassemble a tag. A `<` before a digit or a space
 * stays (`<10`, `a < b`): select options and answers must round-trip.
 */
function stripTags(text: string): string {
  const nextClose = new Int32Array(text.length + 1).fill(-1);
  for (let k = text.length - 1; k >= 0; k -= 1) nextClose[k] = text.charCodeAt(k) === 62 ? k : nextClose[k + 1]!;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 60 && opensTag(text.charCodeAt(i + 1))) {
      const close = nextClose[i + 1]!;
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }
    if (opensTag(code)) {
      let end = out.length;
      while (end > 0 && out.charCodeAt(end - 1) === 60) end -= 1;
      if (end !== out.length) out = out.slice(0, end);
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * Text written by an invitee (a name, a note, an intake answer, a reason).
 * Cleaned and capped so it reads as data: control and invisible characters go,
 * HTML tags go and so does any leftover `<` that could open one (a tag-stripping
 * regex alone lets an unclosed `<script` through), while `<10`, `> 50` or
 * `a < b` survive, because select options and answers must round-trip exactly.
 * Markdown images vanish (an image URL is an exfiltration path), a markdown link
 * keeps its visible text only, and the result is length-capped. The input is cut
 * BEFORE the regexes, so a huge answer cannot make them crawl.
 */
export function untrusted(value: unknown, max = 500): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  text = text
    .slice(0, max * 4)
    .replace(INVISIBLE, '')
    .replace(HIDDEN_ASTRAL, '')
    .replace(CONTROL, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Tags go after everything that removes characters, so nothing can put a `<`
  // back next to a letter. Removing a tag can glue `![x]` to `(url)` again, and the
  // markdown regexes miss nested brackets, so every `](` left is broken apart: no
  // image or link survives as markdown, whatever the order of removals.
  text = stripTags(text).replace(/\]\(/g, '] (').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  // Never cut a surrogate pair in half.
  const cut = /[\uD800-\uDBFF]/.test(text[max - 2] ?? '') ? max - 2 : max - 1;
  return `${text.slice(0, cut)}…`;
}

/** The domain half of an address; the local part is personal data. */
export function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase().slice(0, 100) : null;
}

// --- Audit ----------------------------------------------------------------

const REDACT_KEYS = new Set([
  'name',
  'email',
  'phone',
  'notes',
  'answers',
  'reason',
  'guests',
  'attendee',
  'idempotency_key',
  'hold_id',
  'cursor',
]);

/** The arguments with every personal or secret-like value replaced by a marker. */
export function redactArgs(value: unknown, key = ''): unknown {
  if (REDACT_KEYS.has(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactArgs(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, redactArgs(v, k)]),
    );
  return value;
}

/** Stable short digest of the redacted arguments: same call shape, same hash. */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(redactArgs(args))).digest('hex').slice(0, 16);
}

export { stableStringify } from '../stable-stringify';

// --- Errors ---------------------------------------------------------------

/** What each upstream error code means for the model that triggered it. */
const ACTIONABLE: Record<string, { message?: string; hint: string }> = {
  SLOT_TAKEN: {
    message: 'That time is no longer available.',
    hint: 'Call find_available_slots for current openings, then retry with a new start and a NEW idempotency_key.',
  },
  INVALID_SLOT: {
    message: 'That start time is not an offered slot.',
    hint: 'Only start times returned by find_available_slots can be booked. Fetch slots again and copy one exactly.',
  },
  DUPLICATE_BOOKING: {
    hint: 'This invitee already has an upcoming booking for this event. Do not retry; ask them to check their inbox.',
  },
  CALENDAR_UNAVAILABLE: {
    hint: 'The host calendar could not confirm the time right now. Retry in a few minutes with the same idempotency_key.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    hint: 'That idempotency_key was already used with different arguments. Use a new key for a different request.',
  },
  BOOKING_FIELDS_INVALID: {
    hint: 'Pass an answer for each required intake question in `answers`, keyed by question name. The questions are listed by find_available_slots and list_event_types.',
  },
  GONE: {
    message: 'That booking can no longer be changed (it is cancelled, declined or finished).',
    hint: 'Use get_booking to check its status.',
  },
  HOLD_EXPIRED: {
    message: 'The hold on that time expired, so nothing was booked.',
    hint: 'Call find_available_slots and hold_slot again, then book with the new hold_id and a NEW idempotency_key.',
  },
  TOO_MANY_HOLDS: {
    message: 'This host has too many holds open right now (at most 10 at a time, across all of their event types).',
    hint: 'Book without a hold, or retry in a few minutes (a hold lasts about 10 minutes).',
  },
  FEATURE_NOT_SUPPORTED: { hint: 'This event type uses a feature the MCP tools do not support yet; book it from its public page.' },
};

/** A failure from an upstream error code, with the model-facing advice attached. */
export function failureFor(code: string, message: string): ToolFailure {
  // The booking core reports a bad start time under its intake-validation code.
  if (code === 'BOOKING_FIELDS_INVALID' && /time is not available|start time/i.test(message)) code = 'INVALID_SLOT';
  // The core calls a hold a reservation; the tools call it a hold.
  if (code === 'RESERVATION_EXPIRED') code = 'HOLD_EXPIRED';
  const known = ACTIONABLE[code];
  return new ToolFailure(code, known?.message ?? message, known?.hint);
}

/** Map anything a tool can throw to a `ToolFailure` the model can act on. */
export function toFailure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return new ToolFailure('INVALID_ARGUMENT', `${where}${issue?.message ?? 'Invalid arguments.'}`);
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const body = error.getResponse();
    let code = 'ERROR';
    let message = error.message;
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const nested = record['error'];
      if (nested && typeof nested === 'object') {
        const inner = nested as Record<string, unknown>;
        if (typeof inner['code'] === 'string') code = inner['code'];
        if (typeof inner['message'] === 'string') message = inner['message'];
      } else {
        if (typeof nested === 'string') code = nested;
        if (typeof record['message'] === 'string') message = record['message'];
      }
    }
    if (status === 404 || code === 'RESOURCE_NOT_FOUND' || code === 'NOT_FOUND')
      return new ToolFailure('NOT_FOUND', message || 'Not found.');
    if (status === 429) return new ToolFailure('RATE_LIMITED', 'Too many requests.', 'Wait a moment and retry.', 5);
    if (status >= 500) return new ToolFailure('INTERNAL_ERROR', 'The calendar service failed to complete this call.', 'It is safe to retry with the same idempotency_key.');
    return failureFor(code, message);
  }
  return new ToolFailure('INTERNAL_ERROR', 'The calendar service failed to complete this call.', 'It is safe to retry with the same idempotency_key.');
}

// --- Time ----------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An instant from a model's date string. A bare date (`2026-11-03`) means that
 * local day in `timeZone`: its first instant, or with `endOfDay` the first
 * instant of the next day (an exclusive end). Anything else must carry an
 * offset or `Z`, because a time with no zone is the ambiguity this API exists
 * to remove.
 */
export function instantFrom(input: string, timeZone: string, endOfDay = false): Date {
  if (DATE_ONLY.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    if (new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) !== input)
      throw new ToolFailure('INVALID_ARGUMENT', `Invalid date: ${input}.`);
    const midnightUtc = Date.UTC(y!, m! - 1, d! + (endOfDay ? 1 : 0));
    // First guess assumes UTC; correct by the zone's offset at that instant,
    // then once more in case the correction crossed a DST change.
    let guess = midnightUtc - zoneOffsetMinutes(new Date(midnightUtc), timeZone) * 60_000;
    guess = midnightUtc - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
    const out = new Date(guess);
    if (Number.isNaN(out.getTime())) throw new ToolFailure('INVALID_ARGUMENT', `Invalid date: ${input}.`);
    return out;
  }
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(input))
    throw new ToolFailure(
      'INVALID_ARGUMENT',
      `"${input}" has no time zone offset.`,
      'Use an ISO-8601 time with an offset such as 2026-11-03T15:00:00-05:00, or a bare date like 2026-11-03.',
    );
  const out = new Date(input);
  if (Number.isNaN(out.getTime())) throw new ToolFailure('INVALID_ARGUMENT', `Invalid time: ${input}.`);
  return out;
}

/** ISO-8601 with the zone's own offset (`2026-11-03T10:00:00-05:00`). */
export function zonedIso(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const minutes = zoneOffsetMinutes(instant, timeZone);
  const abs = Math.abs(minutes);
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}
