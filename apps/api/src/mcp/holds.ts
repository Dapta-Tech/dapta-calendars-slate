import { randomBytes } from 'node:crypto';
import type { Db } from '@slate/db';
import { claimApiIdempotency, completeApiIdempotency, hashApiValue, parseJsonColumn, sql } from '@slate/db';
import { type McpCall, callerId } from './support';

/**
 * Holds as the MCP tools hand them out.
 *
 * `hold_slot` places the booking core's own soft hold (`slot_reservation`, the
 * one the booking page takes when a visitor picks a time), so a held time
 * disappears from every availability read for about ten minutes. What the
 * agent gets back is NOT that reservation's uid: the uid is a bearer handle on
 * the public REST routes (whoever holds it may book or release it), and a hold
 * made by one key must not be usable by another. The agent gets an opaque
 * `hold_id` instead, and the only way back from it to the reservation is a
 * binding row namespaced by the account, the hold's owner and the hold id
 * together (see `holdOwner`). A hold made with a key, connection or sign-in is
 * found only by that same key, connection or person; anyone else computes
 * another namespace and finds nothing. An anonymous hold has no owner to bind
 * to, so its hold_id is the capability.
 *
 * The binding lives in `api_idempotency`, which already stores hashed,
 * caller-scoped records with an expiry and sweeps expired ones, so this needs
 * no new table. It outlives the hold (a day), which is what lets a retried
 * booking with the same hold_id still reach its idempotent replay.
 */

const BINDING_PATH = 'hold_slot#binding';
/** 18 random bytes (144 bits): enough to stand alone as a bearer capability. */
const HOLD_ID_BYTES = 18;
const HOLD_ID = /^hold_[A-Za-z0-9_-]{24}$/;

/**
 * The owner of an anonymous hold. An anonymous caller has nothing stable to
 * bind a hold to: its address can change between two calls (hosted connectors,
 * a load balancer or a CDN in the path), and a hold bound to the address it
 * was made from then answered HOLD_NOT_FOUND to its own maker. So an anonymous
 * hold is filed under this one owner and its hold_id, unguessable and never
 * logged, is what proves the right to book it, like the reservation uid on the
 * public booking page. Rate limits and idempotency stay per address.
 */
const BEARER = 'bearer';

/**
 * Who a hold belongs to: the key, connection or signed-in person that made it
 * (`callerId`), or, for an anonymous call, whoever presents its hold_id.
 */
export function holdOwner(call: McpCall): string {
  return call.principal || call.login ? callerId(call) : BEARER;
}

export interface HoldBinding {
  reservationUid: string;
  eventTypeId: string;
  startUtc: string;
  endUtc: string;
  expiresAt: string;
}

function bindingNamespace(accountId: string, caller: string, holdId: string): string {
  return hashApiValue(`mcp-hold:${accountId}:${caller}:${holdId}`);
}

/** Record a fresh hold for its owner (`holdOwner`) and return its opaque id. */
export async function bindHold(db: Db, accountId: string, owner: string, binding: HoldBinding): Promise<string> {
  const holdId = `hold_${randomBytes(HOLD_ID_BYTES).toString('base64url')}`;
  const claim = await claimApiIdempotency(db, {
    namespaceHash: bindingNamespace(accountId, owner, holdId),
    accountId,
    apiKeyId: owner,
    method: 'MCP',
    path: BINDING_PATH,
    requestHash: hashApiValue(binding.reservationUid),
  });
  // The id is fresh, so this call must have opened the record, and the binding
  // is written only while it is still open: never over another record.
  if (!claim.inserted || !(await completeApiIdempotency(db, claim.id, 201, binding, { onlyOpen: true })))
    throw new Error('The hold binding was not stored.');
  return holdId;
}

/**
 * The hold behind `holdId` on this account, if this caller may use it: one it
 * made itself (`owner` is `holdOwner(call)`), or an anonymous one, which
 * anyone presenting its id may book. Null for a malformed id, another key's,
 * connection's or person's hold and an unknown one alike, so the answer is
 * never an oracle for whether a hold exists.
 */
export async function findHold(db: Db, accountId: string, owner: string, holdId: string): Promise<HoldBinding | null> {
  if (!HOLD_ID.test(holdId)) return null;
  for (const who of owner === BEARER ? [BEARER] : [owner, BEARER]) {
    const row = await db.get<{ response_body: unknown }>(
      sql`SELECT response_body FROM api_idempotency
          WHERE namespace_hash = ${bindingNamespace(accountId, who, holdId)} AND path = ${BINDING_PATH}
            AND status_code = 201 AND expires_at > ${Date.now()}
          LIMIT 1`,
    );
    const binding = row ? parseJsonColumn<HoldBinding | null>(row.response_body, null) : null;
    if (binding?.reservationUid) return binding;
  }
  return null;
}

/**
 * True when someone else's unexpired hold covers any part of this time for
 * this host. The booking core only consults holds when it hands out slots, so
 * without this a booking tool called with a start copied from earlier could
 * take a time another booker is holding, which is the race a hold exists to
 * close. `exceptReservationUid` is the caller's own hold being consumed.
 */
export async function heldByAnother(
  db: Db,
  memberId: string,
  startMs: number,
  endMs: number,
  exceptReservationUid?: string,
): Promise<boolean> {
  const except = exceptReservationUid ? sql` AND uid <> ${exceptReservationUid}` : sql``;
  const row = await db.get<{ hit: number }>(
    sql`SELECT 1 AS hit FROM slot_reservation
        WHERE member_id = ${memberId} AND release_at_ms > ${Date.now()}
          AND slot_start_ms < ${endMs} AND slot_end_ms > ${startMs}${except}
        LIMIT 1`,
  );
  return !!row;
}
