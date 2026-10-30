---
'@slate/notifications': minor
'@slate/db': minor
---

A refused email is told apart from a failed one. The transactional wire throws `EmailRefusedError` (exported) when the mail service blocks a message by policy, for example a suppressed recipient, so a caller can record the refusal once instead of retrying it. `CalendarChangeMark`, `findCalendarChangeForInviteeEmail`, `readCalendarChangeMark` and `writeCalendarChangeMark` read and record what a calendar change knows about the invitee email it went out with (whether it was written without the provider's invitation, and whether the provider was asked to invite after all). `CalendarWriteContext` gains an optional `inviteeKey`. `hasPendingCalendarJob` no longer counts a `reinvite` row, which never mints a room. `oldestLiveChainUid` finds where a meeting's .ics SEQUENCE is counted when the first booking's row is gone.
