import { randomBytes } from 'node:crypto';

/**
 * One-off link tokens (#69 / AB2, #110) — the pure half.
 *
 * A one-off link is a GRANT, not a meeting: a token a host mints over an event
 * type they already have, pastes into one message to one intended invitee, and
 * which dies the moment a booking is made against it. The storage side lives in
 * `@slate/db`'s `one-off-link.ts`; this module only mints and shapes.
 *
 * Like the duplicate-booking guard beside it, this is **not a security
 * control** — the per-IP `RateLimitGuard` in `apps/api/src/rate-limit.ts` is.
 * What it buys is that a link pasted to one person cannot be forwarded and
 * re-used a hundred times; it does not authenticate anybody, and the host is
 * free to publish the same event openly at the same time.
 *
 * STORED IN CLEAR, unlike the manage token in `manage-token.ts` next door.
 * That is a deliberate decision, not an oversight, and
 * `docs/adr/0003-public-tokens-have-two-storage-policies.md` is where it was
 * made: the host is this token's CUSTODIAN rather than its recipient, so they
 * re-read it minutes or days after minting and possibly for five candidates at
 * once, and show-once would mean re-minting every time a modal closes. Nothing
 * sits behind the token — presenting it reads no PII and mutates nothing that
 * already exists — so hashing would be nominal on one side and expensive on the
 * other. Read the ADR before "fixing" the inconsistency with the manage token;
 * the inconsistency IS the decision.
 */

/**
 * 256 bits, base64url — the same width as the manage token.
 *
 * Deliberately NOT narrowed despite being the lower-privilege of the two
 * (ADR 0003, Consequences). Enumeration resistance is the whole reason the
 * `410`-versus-`404` split is safe to expose at all: a consumed link may answer
 * distinguishably only because nobody can walk the space to find one.
 */
export function generateOneOffToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The shape a minted token is stored and read back as.
 *
 * `base64url` is `[A-Za-z0-9_-]`, and 32 bytes encode to exactly 43 characters
 * with no padding. Pinned as a regex rather than a length check so a token that
 * arrives from a URL carrying a stray `=` or a `+` from a mangled copy-paste is
 * rejected before it reaches a query, instead of silently missing.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Is `value` shaped like a token this repo minted?
 *
 * The public route runs this BEFORE touching the database. A path segment is
 * caller-controlled and unauthenticated, so rejecting on shape turns every
 * junk request into the same `404` a genuinely missing route gives, without
 * spending a query on it. It is a cheap filter, never the authorisation — the
 * lookup is.
 */
export function isOneOffTokenShape(value: string | null | undefined): boolean {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * The lifecycle state a link is in, as the public surface sees it.
 *
 * Three states, and the two dead ones are deliberately NOT collapsed:
 *
 *   `live`      never used, never revoked — it opens a booking page
 *   `consumed`  a booking was made against it, `pending` included
 *   `revoked`   the host killed it by hand
 *
 * `consumed` and `revoked` both answer `410` on the public surface — the link
 * existed and is gone, which is exactly what `410 Gone` means — while a token
 * that names nothing answers `404`. The host's own list keeps them apart
 * because "someone booked this" and "I cancelled this" are different facts
 * about the same link.
 */
export type OneOffLinkState = 'live' | 'consumed' | 'revoked';

/**
 * Derive the state from the three timestamps the row carries.
 *
 * CONSUMED WINS OVER REVOKED when both are set. A host who revokes a link that
 * has already produced a booking has not undone the booking, and reporting
 * "revoked" there would hide the one fact that matters about that link.
 *
 * Note what is NOT here: a cancel. A booking that is later cancelled leaves
 * `consumed_at` exactly where it was, so the link stays dead — the link did its
 * job the moment it produced a booking, and the host mints another. That rule
 * is asserted directly in `one-off-link.spec.ts`, because it is the one a
 * future refactor will get wrong.
 */
export function oneOffLinkState(row: {
  consumedAt?: number | null;
  revokedAt?: number | null;
}): OneOffLinkState {
  if (row.consumedAt) return 'consumed';
  if (row.revokedAt) return 'revoked';
  return 'live';
}

/**
 * The public path a minted token is pasted as.
 *
 * ONE definition, because three callers have to agree on it: the admin list
 * that a host copies from, the API view that feeds that list, and the web route
 * that serves it. A second spelling anywhere means a host copies a link that
 * 404s.
 *
 * `/booking/<token>` — a dedicated top-level route whose ENTIRE address is the
 * token. The reasoning for that shape, which is the load-bearing design
 * decision in #110, is written at `apps/web/app/booking/[token]/page.tsx`.
 */
export function oneOffLinkPath(token: string): string {
  return `/booking/${token}`;
}
