---
"@slate/web": minor
---

Let a booking page start its form filled from its own address, so a visitor sent
here by a page that already asked for their name and email does not type either
one again on the way to a slot. The three public entry points read it
(`prefillFromQuery`): the personal event page, the team event page and the
one-off link page. A prefilled input is a STARTING value and nothing more: it
stays editable, keeps its required flag, and is validated exactly as a typed one
is. The custom answers fill as the questions arrive with the first availability
read, and never overwrite a value the visitor has already typed or cleared.
