---
"@slate/web": minor
---

Let a booking page start its form filled from its own address, so a visitor sent
here by a page that already asked for their name and email does not type either
one again on the way to a slot. The three public entry points read it
(`prefillFromQuery`): the personal event page, the team event page and the
one-off link page.

A prefilled input is a STARTING value and nothing more: it stays editable, keeps
its required flag, and is validated exactly as a typed one is. The two field
types that render something narrower than the string they hold are seeded
through their own reading first, so what the field shows is what the booking
gets: a phone keeps only a dial code and digits (`canonicalPhoneValue`, with the
event's default country when the value carries none) and a value with no digits
in it leaves the field empty; a number only takes a number. The custom answers
fill as the questions arrive with the first availability read, and never
overwrite a value the visitor has already typed or cleared.

The prefill is then taken out of the address. A booking page runs the host's own
analytics tags, and GA4, Meta, HubSpot and a host PostHog all send the page URL,
so an invitee's email left in the query would reach those vendor accounts before
the invitee submitted anything. The island clears those parameters with
`replaceState` as soon as it has them, which also keeps the address out of the
visitor's history and out of any link they copy.
