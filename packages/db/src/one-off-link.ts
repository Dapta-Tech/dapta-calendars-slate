import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { generateOneOffToken, oneOffLinkState, type OneOffLinkState } from '@slate/engine';
import type { Db } from './client';

/**
 * One-off links (#69, unit AB2 / #110) — the storage side.
 *
 * A token a host mints over an event type they ALREADY have, pastes into one
 * message to one intended invitee, and which dies the moment a booking is made
 * against it. The pure half (minting, shape, state derivation, the public path)
 * is `@slate/engine`'s `one-off-link.ts`.
 *
 * It exists against the second of the three unrelated problems #69 named —
 *
 *   automated flood            → the per-IP RateLimitGuard, already shipped
 *   a link reaching strangers  → this
 *   one person hogging slots   → the duplicate-booking guard (AB1)
 *
 * — and, exactly like that guard, it is **not a security control**. It stops a
 * link pasted to one person from being forwarded and re-used a hundred times.
 * It authenticates nobody, it verifies no identity, and a host who leaves the
 * event type publicly bookable has limited nothing at all (which is why the
 * editor warns about that where the link is minted). Keep that framing in any
 * copy or comment that grows out of this file.
 *
 * Lives in its own module for the same reason `duplicate-guard.ts` does: the
 * two public write paths it guards are in two different files with two
 * different outcome unions — `createBooking` in `repository.ts` and
 * `createTeamBooking` in `parity.ts`. One implementation, two call sites.
 */

/** The stored row, snake_case as it comes back from both dialects. */
interface OneOffLinkDbRow {
  id: string;
  account_id: string;
  event_type_id: string;
  token: string;
  created_by_member_id: string | null;
  created_at: number | string;
  consumed_at: number | string | null;
  consumed_booking_id: string | null;
  revoked_at: number | string | null;
}

/** One link, as every caller above the repository reads it. */
export interface OneOffLinkRecord {
  id: string;
  accountId: string;
  eventTypeId: string;
  /** IN CLEAR and re-readable — ADR 0003. This is what the host copies. */
  token: string;
  createdByMemberId: string | null;
  createdAt: number;
  consumedAt: number | null;
  /** The booking that consumed it, so the host's list can say which. */
  consumedBookingUid: string | null;
  revokedAt: number | null;
  state: OneOffLinkState;
}

/** SQLite hands epoch-ms back as a number, Postgres `bigint` as a string. */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toRecord(row: OneOffLinkDbRow, consumedBookingUid: string | null = null): OneOffLinkRecord {
  const consumedAt = num(row.consumed_at);
  const revokedAt = num(row.revoked_at);
  return {
    id: row.id,
    accountId: row.account_id,
    eventTypeId: row.event_type_id,
    token: row.token,
    createdByMemberId: row.created_by_member_id,
    createdAt: num(row.created_at) ?? 0,
    consumedAt,
    consumedBookingUid,
    revokedAt,
    state: oneOffLinkState({ consumedAt, revokedAt }),
  };
}

const LINK_COLUMNS = sql`id, account_id, event_type_id, token, created_by_member_id, created_at,
                         consumed_at, consumed_booking_id, revoked_at`;

/**
 * Mint a link over an event type the caller's account owns.
 *
 * `accountId` is not decoration: the event type is re-checked against it here
 * even though the controller already resolved the principal, because this
 * function is exported from `@slate/db` and the next caller must not be able to
 * mint a grant over another tenant's event by holding an id alone (invariant 4,
 * the same defence in depth `hasUpcomingBookingForEmail` takes).
 *
 * Returns `undefined` when the event type is not this account's — the caller
 * turns that into the same 404 a missing event type gives, never a 403, so the
 * route is not an oracle for which ids exist in other accounts.
 *
 * N per event type, with no cap. #110 says "N per event type" and names no
 * limit, and a cap here would be a host-side volume control — explicitly
 * deferred at #69 along with the configurable N for the duplicate guard.
 */
export async function mintOneOffLink(
  db: Db,
  args: { accountId: string; eventTypeId: string; createdByMemberId?: string | null },
  now = Date.now(),
): Promise<OneOffLinkRecord | undefined> {
  const owns = await db.get<{ id: string }>(
    sql`SELECT id FROM event_type
        WHERE id = ${args.eventTypeId} AND account_id = ${args.accountId} LIMIT 1`,
  );
  if (!owns) return undefined;

  const row: OneOffLinkDbRow = {
    id: randomUUID(),
    account_id: args.accountId,
    event_type_id: args.eventTypeId,
    token: generateOneOffToken(),
    created_by_member_id: args.createdByMemberId ?? null,
    created_at: now,
    consumed_at: null,
    consumed_booking_id: null,
    revoked_at: null,
  };
  await db.run(
    sql`INSERT INTO one_off_link (id, account_id, event_type_id, token, created_by_member_id, created_at)
        VALUES (${row.id}, ${row.account_id}, ${row.event_type_id}, ${row.token},
                ${row.created_by_member_id}, ${now})`,
  );
  return toRecord(row);
}

/**
 * Every link on one event type, newest first — the host's list.
 *
 * Joins the consuming booking for its `uid` so the list can link to it. A LEFT
 * join, because `consumed_booking_id` is NULL on a live link and because a
 * booking row that was later hard-deleted must not make the link vanish from
 * the list: the link is still consumed, which is the fact the host needs.
 */
export async function listOneOffLinks(
  db: Db,
  accountId: string,
  eventTypeId: string,
): Promise<OneOffLinkRecord[]> {
  const rows = await db.all<OneOffLinkDbRow & { booking_uid: string | null }>(
    sql`SELECT l.id AS id, l.account_id AS account_id, l.event_type_id AS event_type_id,
               l.token AS token, l.created_by_member_id AS created_by_member_id,
               l.created_at AS created_at, l.consumed_at AS consumed_at,
               l.consumed_booking_id AS consumed_booking_id, l.revoked_at AS revoked_at,
               b.uid AS booking_uid
          FROM one_off_link l
          LEFT JOIN booking b ON b.id = l.consumed_booking_id
         WHERE l.account_id = ${accountId} AND l.event_type_id = ${eventTypeId}
         ORDER BY l.created_at DESC`,
  );
  return rows.map((r) => toRecord(r, r.booking_uid));
}

/**
 * Kill a link by hand.
 *
 * ADR 0003 makes this a CONDITION of storing the token in clear, not a nicety:
 * "because the token is re-readable, revocation has to be real". A host who
 * pastes a link into the wrong thread has no other way to take it back.
 *
 * Scoped to BOTH the account and the event type, in the WHERE clause rather
 * than checked first, so the scope is part of the write itself and cannot drift
 * from a separate read.
 *
 * `eventTypeId` is not decoration and is the reason this takes four arguments.
 * The route that calls it resolves its permission against the event type NAMED
 * IN THE PATH — `assertOwnsOrAdmin`, which makes team events admin-only — and
 * if the link were addressed by id alone, that check would say nothing about
 * the row actually mutated. A member could then revoke a link on a colleague's
 * event, or on a team event they may not administer, by pairing their own
 * event's id with someone else's link id. Account scoping alone does not stop
 * it: both rows are in the same account. The event type has to be part of the
 * predicate.
 *
 * Returns false for a link that is not this account's, or not this event
 * type's, or already revoked — all indistinguishable from one that does not
 * exist, which is what keeps the route from confirming other tenants' ids.
 *
 * Does NOT touch `consumed_at`. Revoking a link that already produced a booking
 * changes nothing about that booking, and `oneOffLinkState` reports such a row
 * as consumed rather than revoked for exactly that reason.
 */
export async function revokeOneOffLink(
  db: Db,
  accountId: string,
  eventTypeId: string,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const hit = await db.get<{ id: string }>(
    sql`UPDATE one_off_link SET revoked_at = ${now}
         WHERE id = ${id} AND account_id = ${accountId}
           AND event_type_id = ${eventTypeId} AND revoked_at IS NULL
         RETURNING id`,
  );
  return !!hit;
}

/** Where a resolved link points — enough for the public page to render it. */
export type OneOffLinkTarget =
  | { kind: 'personal'; accountCode: string; handle: string; slug: string }
  | { kind: 'team'; accountCode: string; teamSlug: string; slug: string };

/**
 * What the public surface learns about a presented token.
 *
 * `undefined` (this function's absent return) is the FOURTH outcome and the one
 * that matters most: a token that names nothing at all, which the route turns
 * into the same 404 any missing route gives.
 */
export type OneOffLinkResolution =
  | { state: 'live'; link: OneOffLinkRecord; target: OneOffLinkTarget }
  | { state: 'consumed' | 'revoked' };

/**
 * Resolve a presented token to the event it opens.
 *
 * Unauthenticated and reached from a URL path, so it takes the token alone —
 * there is no account to scope by, which is the whole point of a bearer grant.
 * The 256-bit token IS the scope, and the unique index on it is the lookup.
 *
 * A link whose event type has been DELETED resolves to `undefined` rather than
 * to a dead state: the join drops it, and "the thing this pointed at is gone"
 * is a missing route, not a consumed link. Same for a team event whose team has
 * no slug — that event is not addressable on any public route (the same reason
 * `rescheduleContextOf` in the booking service answers no context for it), so a
 * link to it opens nothing and must not pretend otherwise.
 *
 * `hidden` is deliberately NOT a filter here. Reaching an event the ordinary
 * public URL cannot is the entire value of a one-off link; a link over a
 * VISIBLE event resolves too, and limits nothing, which is what the editor
 * warns the host about where they mint it.
 */
export async function resolveOneOffLink(
  db: Db,
  token: string,
): Promise<OneOffLinkResolution | undefined> {
  const row = await db.get<
    OneOffLinkDbRow & {
      account_code: string;
      account_vanity: string | null;
      event_slug: string;
      team_id: string | null;
      member_handle: string | null;
      team_slug: string | null;
    }
  >(
    sql`SELECT l.id AS id, l.account_id AS account_id, l.event_type_id AS event_type_id,
               l.token AS token, l.created_by_member_id AS created_by_member_id,
               l.created_at AS created_at, l.consumed_at AS consumed_at,
               l.consumed_booking_id AS consumed_booking_id, l.revoked_at AS revoked_at,
               a.code AS account_code, a.vanity_slug AS account_vanity,
               e.slug AS event_slug, e.team_id AS team_id,
               m.handle AS member_handle, t.slug AS team_slug
          FROM one_off_link l
          JOIN event_type e ON e.id = l.event_type_id
          JOIN account a ON a.id = l.account_id
          LEFT JOIN member m ON m.id = e.member_id
          LEFT JOIN team t ON t.id = e.team_id
         WHERE l.token = ${token}
         LIMIT 1`,
  );
  if (!row) return undefined;

  const record = toRecord(row);
  // Both dead states answer the same 410 upstream; they stay apart here because
  // the host's own list distinguishes "someone booked this" from "I killed it".
  if (record.state !== 'live') return { state: record.state };

  // The CANONICAL code, never the raw one: a host who has since claimed a
  // vanity slug should not have their old one-off links resolve to a code that
  // then 308s. Because the link stores an event-type id rather than a URL, it
  // survives a vanity change outright — this is where that survival happens.
  const accountCode = row.account_vanity ?? row.account_code;

  // `team_id` decides, not `team_slug`, matching `rescheduleContextOf`: a team
  // event type has no `member_id`, so the personal branch could never resolve
  // one, and answering the personal shape for it would send the page at a route
  // that cannot find the event.
  if (row.team_id) {
    if (!row.team_slug) return undefined;
    return {
      state: 'live',
      link: record,
      target: { kind: 'team', accountCode, teamSlug: row.team_slug, slug: row.event_slug },
    };
  }
  if (!row.member_handle) return undefined;
  return {
    state: 'live',
    link: record,
    target: { kind: 'personal', accountCode, handle: row.member_handle, slug: row.event_slug },
  };
}

/**
 * The same lookup the write paths use, without the join — they already hold the
 * event type and only need to know whether this token is live and WHICH event
 * it opens.
 */
export async function getOneOffLinkByToken(
  db: Db,
  token: string,
): Promise<OneOffLinkRecord | undefined> {
  const row = await db.get<OneOffLinkDbRow>(
    sql`SELECT ${LINK_COLUMNS} FROM one_off_link WHERE token = ${token} LIMIT 1`,
  );
  return row ? toRecord(row) : undefined;
}

/**
 * Burn the link, naming the booking that did it.
 *
 * `pending` COUNTS. A booking on a confirmation-gated event type is still a
 * booking for this purpose — the link did its job the moment it produced one,
 * and a host who has not yet confirmed has still had the meeting requested. The
 * write path calls this for both statuses and never looks at which.
 *
 * A later CANCEL never calls this and never clears it. That is the rule a
 * future refactor is most likely to get wrong ("cancelled, so free it up
 * again"), and `one-off-link.spec.ts` asserts it directly for that reason: the
 * host mints another link, they do not get the old one back.
 *
 * CONDITIONAL on the link still being live, and the condition is in the WHERE
 * clause so the check and the write are one statement on both dialects
 * (`RETURNING` — Postgres always, SQLite since 3.35, and this repo's
 * better-sqlite3 ships far past that; `growth.ts` takes the same route).
 * Two simultaneous submissions therefore produce at most ONE row that records a
 * consumer, and the loser reports false.
 *
 * It runs AFTER the booking is committed, not before, and that ordering is a
 * deliberate trade rather than an oversight. Burning the link first would kill
 * it on every `SLOT_TAKEN` — the common race — and strand an invitee with a
 * dead link and no booking, which is far worse than the two residuals it
 * leaves:
 *
 *   - two genuinely simultaneous submissions on one link can both land, and
 *     only one of them is recorded as the consumer;
 *   - if this statement itself fails (a dropped connection, an exhausted pool),
 *     the booking exists and the link stays live, so it can be spent again.
 *
 * Both fail in the direction of a booking that happened being kept, which is
 * the right way round: a one-off link is a convenience, and the meeting is the
 * thing that matters. It is the same advisory posture the duplicate-booking
 * guard beside it takes, for the same reason, and it takes nothing from the
 * double-booking guarantee, which is enforced downstream by the overlap check
 * and the Postgres EXCLUDE constraint.
 */
export async function consumeOneOffLink(
  db: Db,
  linkId: string,
  bookingId: string,
  now = Date.now(),
): Promise<boolean> {
  const hit = await db.get<{ id: string }>(
    sql`UPDATE one_off_link
           SET consumed_at = ${now}, consumed_booking_id = ${bookingId}
         WHERE id = ${linkId} AND consumed_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
  );
  return !!hit;
}

/**
 * Whether a presented one-off token is HONOURED on this write at all.
 *
 * Two exemptions, named after the two AB1 already wrote down and reached the
 * same way rather than through a second mechanism invented for this unit:
 *
 *   `onBehalf`    a host creating a booking from their own dashboard
 *   `apiKeyWrite` a server-side integration writing through the public API
 *
 * An exempt write is not SUBJECT to the grant at all: it never needs a token,
 * and a token that rides along on one is neither validated nor burned. The host
 * is the party the grant belongs to, so the host is never subject to it, and an
 * integration writing on the account's behalf is the host.
 *
 * What exemption does NOT do is widen visibility. A hidden event type stays
 * hidden to these writes exactly as it is today — `getEventType` still filters
 * on it — because only a resolved link sets `includeHidden`. Whether a host
 * write should reach its own hidden events is a separate question this unit
 * deliberately leaves where it found it.
 *
 * `onBehalf` alone would get this wrong for exactly the reason it does in
 * `duplicate-guard.ts`: the v2 compatibility surface is an API-key write that
 * deliberately reports `onBehalf: false`, and the team write path has no
 * `onBehalf` argument at all.
 */
export function oneOffGuardApplies(opts: { onBehalf?: boolean; apiKeyWrite?: boolean }): boolean {
  return !opts.onBehalf && !opts.apiKeyWrite;
}
