---
"@slate/types": minor
"@slate/engine": minor
"@slate/db": minor
"@slate/shared": minor
---

One-off invite links — a token a host mints over an event type they already have,
pastes into one message to one intended invitee, and which dies the moment a booking
is made against it (#69 / AB2, closing #110).

**It is a grant, not a meeting.** The new `one_off_link` table holds which event type,
the token, who minted it, when, and what consumed it. There is deliberately no duration,
no availability and no title: an ad-hoc meeting that exists only as a link would be a
second kind of bookable object, and that stays deferred at #69.

**Like the duplicate-booking guard it ships beside, it is not a security control.**
The per-IP rate limiter is. What a one-off link buys is that a link sent to one person
cannot be forwarded and re-used a hundred times. It authenticates nobody.

**It dies on booking, `pending` included, and a cancel never revives it.** A pending
booking is a booking for this purpose — the link did its job the moment it produced
one. Cancelling that booking leaves the link spent and the host mints another. That
rule is asserted directly on both dialects, because it is the one a future refactor
will get wrong.

**The token is stored in clear, unique and re-readable**, which is the opposite of
`booking.manage_token_hash` one table over. That inconsistency is the decision, made in
[ADR 0003](docs/adr/0003-public-tokens-have-two-storage-policies.md): the host is this
token's custodian rather than its recipient, so they copy it again hours or days after
minting; presenting it reads no PII and mutates nothing that already exists. Because it
is re-readable, revocation is real — the editor lists live links and can withdraw one,
which the ADR makes a condition of the storage choice rather than a nicety.

**Three public codes, three causes.** A consumed or revoked link answers `410`; a token
that names nothing answers `404` with the same body any missing route gives, and says
nothing about invite links existing at all; AB1's `409 DUPLICATE_BOOKING` is untouched.
That split is what constrains the URL shape: a token carried as a query parameter on the
normal public event URL could never answer `404`, because that page renders perfectly
well without it. So the token is the whole address — `/booking/{token}`, a prefix no
account can claim (it is on `RESERVED_PUBLIC_SLUGS`), outside the product prefixes so
`?embed=1` and framing are unchanged, and carrying no account code at all, which is why
the canonical-code 308 cannot fire on it. A link therefore survives its account claiming
a vanity slug, because it stores an event-type id rather than a URL.

**Both public write paths honour it** — `createBooking` and `createTeamBooking`. Host
on-behalf and API-key writes are exempt exactly as they are for AB1, through the same
mechanism rather than a second one: they never need a token and a token they happen to
carry is neither validated nor burned.

**`getEventType` and `getTeamEventType` gain an opt-in to see hidden event types.** That
is the seam that makes the feature work at all — a one-off link only limits anything over
an event hidden from the booking page, and reaching such an event is the whole point. The
flag is set only after a token has been resolved and re-checked against that exact event
type, and every existing caller keeps today's behaviour. Exemption is not a visibility
widening: a hidden event stays as hidden to host and API-key writes as it is today.

**A link over a still-public event limits nothing, and the editor says so** where the host
mints it. Copy plus a condition, never a block — the host may have a reason.

Migrations are additive and ship in both dialects (postgres `0021`, sqlite `0020`), adding
one new table plus a unique index on the token.
