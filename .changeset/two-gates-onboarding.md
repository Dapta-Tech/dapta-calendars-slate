---
"@slate/engine": minor
"@slate/types": minor
"@slate/db": minor
"@slate/config": minor
"@slate/shared": major
---

Add onboarding's two gates: account qualification and per-host setup.

Qualification is claimed write-once on the account and owed by owner/admin only;
setup is owed by every active member with no published event type of their own,
invited members included, and has no completion claim — it is satisfied by the
event type existing, so a host who deletes their last one is guided again.

Also corrects the "Get bookable" checklist. It measured the member's handle,
which is auto-created for everyone, so it reported "bookable" to every host in
the product while their public page rendered nothing. It now measures whether
the host has at least one published event type.

`@slate/shared` note: the `admin.home` keys `setupLinkTitle` / `setupLinkDesc`
are replaced by `setupEventTitle` / `setupEventDesc` / `setupEventAction`. The
old keys described a shareable link on a row that now measures published event
types, so keeping the names would preserve the wrong claim in the catalogue.
