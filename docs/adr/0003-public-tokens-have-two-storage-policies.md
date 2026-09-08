# Public tokens have two storage policies: manage tokens hashed, one-off links in clear

## Context

Calendars will soon hold two kinds of unauthenticated, URL-borne token on its
public surface, and a reader who meets the second one will reasonably ask why it
is not stored the way the first one is.

The **manage token** (`packages/engine/src/manage-token.ts`) already exists: 256
random bits, SHA-256 at rest, verified in constant time, exactly one active per
booking, and the plaintext is returned once — in the create-booking response and
the confirmation email — and never persisted. Rotating on reschedule overwrites
the stored hash, so at most one token is ever valid.

The **one-off link** (#69) is new: a token minted by a host, pasted into a
message to one intended invitee, that dies once a booking is made against it.

Applying the manage token's policy to the one-off link is the obvious move, and
it is wrong here.

## Decision

Store the one-off link token **in clear**, unique, re-readable by the host for
as long as the link is alive. Keep the manage token hashed and show-once.

Two public tokens, two deliberate policies.

## Why

They guard different things.

A manage token is a **capability over one booking's PII**: present it and you can
read the invitee's name, email and answers, cancel the meeting, or move it. A
leak of the at-rest store must not hand that over, and the invitee already has
the plaintext in their inbox, so show-once costs them nothing.

A one-off link token is a **capability to create a booking on an event the host
wants booked**. Presenting it reads nothing and mutates nothing that already
exists; the worst a leaked one does is what the host was trying to make happen
anyway, one time, on a slot the host published. There is no PII behind it.

Against that, hashing has a real cost on this side. The host is the token's
custodian, not its recipient: they mint it, then paste it into an email, a DM,
or an ATS field, possibly minutes or days later, possibly for five candidates at
once. Show-once means closing a modal destroys the link and the host mints
another. Paying that, repeatedly, to protect a capability with nothing behind it
is a bad trade — security that is nominal on one side and expensive on the other.

## Consequences

- A reader comparing `one_off_link.token` to `booking.manage_token_hash` should
  read this ADR before "fixing" the inconsistency. The inconsistency is the
  decision.
- The rule that separates them is **what the token can read**, not that it is
  public. Any future public token that exposes booking data, invitee identity, or
  host configuration follows the manage token and is hashed. A token that can
  only create something the host already published may follow this one.
- Because the token is re-readable, revocation has to be real: the admin surface
  lists live links and can revoke one, and a revoked or consumed link answers
  `410`, distinct from the `404` a guessed token gets.
- The token stays 256 bits despite being lower-privilege. Enumeration resistance
  is what makes the `410`/`404` split safe to expose, and narrowing it would buy
  nothing.
