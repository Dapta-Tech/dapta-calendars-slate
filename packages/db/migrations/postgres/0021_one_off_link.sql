-- One-off links (#69 / AB2, #110). Additive and SAFE: one NEW table, nothing
-- altered, so an already-running deployment is untouched until a host mints a
-- link. Order-independent with respect to any other unit that happens to share
-- the number 0021 (#71, Mechanical conventions; migrate.ts keys `_migrations`
-- on the FILENAME, not on the number).
--
-- WHAT THIS TABLE IS. A grant, not a meeting. A host mints a token over an
-- event type they ALREADY have, pastes it into one message to one intended
-- invitee, and it dies the moment a booking is made against it. There is
-- deliberately no length, no schedule and no title: an ad-hoc meeting that
-- exists only as a link is a second kind of bookable object and stays deferred
-- at #69. Every column here describes the GRANT.
--
-- NOT A SECURITY CONTROL, exactly as the duplicate-booking guard in 0015 is
-- not. The security control is the per-IP limiter in apps/api/src/rate-limit.ts.
-- What a one-off link buys is that a link pasted to one person cannot be
-- forwarded and re-used a hundred times. It authenticates nobody.
--
-- THE TOKEN IS STORED IN CLEAR, and that is the opposite of what
-- booking.manage_token_hash does one table over. The decision is
-- docs/adr/0003-public-tokens-have-two-storage-policies.md: the host is this
-- token's CUSTODIAN rather than its recipient, so they re-read it minutes or
-- days after minting and possibly for five candidates at once, and show-once
-- would mean re-minting every time a modal closes. Presenting the token reads
-- no PII and mutates nothing that already exists. Read the ADR before
-- "fixing" the inconsistency — the inconsistency is the decision.
--
-- THREE NULLABLE TIMESTAMPS, not a status column, so the row records what
-- happened rather than a verdict somebody has to keep in sync:
--   consumed_at + consumed_booking_id  a booking was made against it
--   revoked_at                         the host killed it by hand
-- A later CANCEL of that booking does NOT clear consumed_at. The link did its
-- job the moment it produced a booking; the host mints another. That rule is
-- asserted directly in packages/db/src/one-off-link.spec.ts.
--
-- NO FOREIGN KEYS, matching every other table in this schema (SQLite parity —
-- the portable subset does not enforce them either, and a schema that only
-- constrains on one dialect is worse than one that constrains on neither).

CREATE TABLE IF NOT EXISTS one_off_link (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT   NOT NULL,
  event_type_id         TEXT   NOT NULL,
  token                 TEXT   NOT NULL,
  created_by_member_id  TEXT,
  created_at            BIGINT NOT NULL,
  consumed_at           BIGINT,
  consumed_booking_id   TEXT,
  revoked_at            BIGINT
);

-- The public lookup, and the reason a guessed token can answer 404 cheaply:
-- GET /booking/<token> resolves through exactly this index. UNIQUE because the
-- token is the whole address — two rows sharing one would make which event a
-- link opens depend on row order. It is also the collision backstop for
-- `generateOneOffToken`, which mints 256 bits and therefore never collides in
-- practice; the constraint is a correctness guarantee, not a hot path.
CREATE UNIQUE INDEX IF NOT EXISTS one_off_link_token_uq ON one_off_link (token);

-- The host's list: "every link on this event type, newest first", which is what
-- the minting panel on the event-type form renders. Account-scoped first so the
-- index cannot be used to read across tenants even by a caller holding only an
-- event-type id (invariant 4, defence in depth).
CREATE INDEX IF NOT EXISTS one_off_link_account_event_idx
  ON one_off_link (account_id, event_type_id, created_at);
