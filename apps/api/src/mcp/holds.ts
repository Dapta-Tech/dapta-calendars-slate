import { randomBytes } from 'node:crypto';
import type { Db } from '@slate/db';
import { claimApiIdempotency, completeApiIdempotency, hashApiValue, parseJsonColumn, sql } from '@slate/db';

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
 * binding row namespaced by the account, the caller and the hold id together.
 * Another caller (a different key, connection, signed-in person or anonymous
 * address) computes another namespace and finds nothing.
 *
 * The binding lives in `api_idempotency`, which already stores hashed,
 * caller-scoped records with an expiry and sweeps expired ones, so this needs
 * no new table. It outlives the hold (a day), which is what lets a retried
 * booking with the same hold_id still reach its idempotent replay.
 */

const BINDING_PATH = 'hold_slot#binding';
const HOLD_ID = /^hold_[A-Za-z0-9_-]{24}$/;

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

/** Record a fresh hold for this caller and return its opaque id. */
export async function bindHold(db: Db, accountId: string, caller: string, binding: HoldBinding): Promise<string> {
  const holdId = `hold_${randomBytes(18).toString('base64url')}`;
  const claim = await claimApiIdempotency(db, {
    namespaceHash: bindingNamespace(accountId, caller, holdId),
    accountId,
    apiKeyId: caller,
    method: 'MCP',
    path: BINDING_PATH,
    requestHash: hashApiValue(binding.reservationUid),
  });
  await completeApiIdempotency(db, claim.id, 201, binding);
  return holdId;
}

/**
 * The hold behind `holdId`, if THIS caller made it on this account. Null for a
 * malformed id, someone else's hold and an unknown one alike, so the answer is
 * never an oracle for whether a hold exists.
 */
export async function findHold(db: Db, accountId: string, caller: string, holdId: string): Promise<HoldBinding | null> {
  if (!HOLD_ID.test(holdId)) return null;
  const row = await db.get<{ response_body: unknown }>(
    sql`SELECT response_body FROM api_idempotency
        WHERE namespace_hash = ${bindingNamespace(accountId, caller, holdId)} AND path = ${BINDING_PATH}
          AND status_code = 201 AND expires_at > ${Date.now()}
        LIMIT 1`,
  );
  const binding = row ? parseJsonColumn<HoldBinding | null>(row.response_body, null) : null;
  return binding?.reservationUid ? binding : null;
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
