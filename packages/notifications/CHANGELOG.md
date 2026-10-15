# @slate/notifications

## 0.1.0

### Minor Changes

- ff2e458: Deliver the conferencing link: mint exactly one room per booking and resolve
  `{{meeting_url}}` when the mail is sent.

  A team booking used to request a conferencing link on every write destination,
  minting one room per host for a single meeting. Destinations are now ordered
  organizer-first, only the first requests a link, and co-hosts are written in a
  second pass carrying that URL — so every `booking_reference` row for a booking
  names the same room.

  `{{meeting_url}}` joins the template variables as the one value resolved at
  delivery rather than snapshotted at enqueue: it is minted later, by the calendar
  outbox row, so an enqueue-time snapshot can never contain it. A conferencing
  booking's confirmation and reschedule mail is made due slightly late and waits a
  bounded number of attempts for the link, then sends without it. A calendar
  failure costs the link, never the email and never the booking.

  The link now appears in the confirmation, reschedule and reminder mail for both
  the attendee and the host, in EN and ES, in the plain-text body and as a Join
  call-to-action in the branded HTML; the `.ics` carries it as `LOCATION` plus a
  `URL:` property. A reschedule persists a returned link only when it is non-null,
  so a backend that keeps the same room can no longer blank a good stored URL.

- 72f921c: Move reminders and the follow-up from the account to the event type.

  Each event type carries a list of `{ id, kind, enabled, leadMinutes, subject, body }`
  rows on the new additive `event_type.reminders` column: every reminder has its own
  switch, its own lead time and its own copy, capped at 10 plus one follow-up. A new
  event type is born with 24h + 1h enabled and the follow-up off.

  Reminder copy can quote the event's own intake answers through a new
  `{{form.<field name>}}` namespace. The prefix is what keeps a question named
  `location` from shadowing the built-in `{{location}}`, so no new names are reserved
  and existing saved forms keep working. An unanswered or deleted question renders
  empty and its line is dropped, exactly as an absent built-in already does.

  Existing event types are given a copy of their account's current lead times and copy
  by an idempotent migration fixup, so no host loses configuration and no invitee's
  mail moves. `attendee_reminder`, `host_reminder` and `follow_up` are no longer
  listed or editable in Settings → Notifications; the 9 transactional keys are
  unchanged. The host side of a reminder keeps its shipped template — the row's
  subject and body are the invitee copy.

  Two consequences worth stating. Host-side reminder _copy_ stops being editable
  (its lead time and its on/off become per-event, which is the upgrade). And a
  stored `host_reminder: disabled` survives as a legacy **mute** on the host side —
  it can silence, never enable — so a host who had turned their own copies off does
  not start receiving them again; an account that never touched it is unaffected.

### Patch Changes

- a4a0e0d: The host's copy of a booking email states the time in the host's own zone, and the invitee's copy in the invitee's, subject included. Every copy used to be formatted in the invitee's zone, so a host in Bogota booked by an invitee in Phoenix read "12:00 PM MST" for a meeting at 2:00 PM their time.

  `loadBookingNotificationContext` now returns the host member's zone (`member.time_zone`, the zone the host's bookings page uses) as `host.timeZone`; the email payload snapshots it, and the new `recipientTimeZone` helper picks the reader's zone for every time variable and the legacy copy. A host row queued before the payload carried the zone reads it at delivery. Messages with no audience, and host payloads without a readable zone (forks that build notifications directly), keep the invitee's zone. Co-hosts share the host side's one message, so they read the organizer's zone. A member who has never set a zone is still on the `UTC` default (the dashboard sets it from the browser on first visit), so their host copies read in UTC, as their bookings page does; like every other snapshotted value, a row keeps the zone it was queued with. The `.ics` attachments are unchanged.

- 3fbc7ac: A hold on a time is exclusive even when visitors pick it at the same moment, and the per-page cap on active holds holds under concurrency (`reserveSlot` re-checks overlap and the cap inside a transaction on the host's row). The host's copy of a booking request asks the host to confirm or decline, instead of wearing the invitee's words and the invitee's "Cancel request" button.
- Updated dependencies [22252c0]
- Updated dependencies [366483e]
- Updated dependencies [37af7ec]
- Updated dependencies [7c23eba]
- Updated dependencies [e108700]
- Updated dependencies [750f261]
- Updated dependencies [327819e]
- Updated dependencies [7c38767]
- Updated dependencies [7581691]
- Updated dependencies [cf36a64]
- Updated dependencies [c64d80c]
- Updated dependencies [a9ea2ca]
- Updated dependencies [c8ce5e0]
- Updated dependencies [07e6932]
- Updated dependencies [d1a4a89]
- Updated dependencies [90393cf]
- Updated dependencies [7ebb22a]
- Updated dependencies [826dd17]
- Updated dependencies [03fd0e0]
- Updated dependencies [72f921c]
- Updated dependencies [6016620]
- Updated dependencies [01c172b]
- Updated dependencies [76ed907]
- Updated dependencies [f64052d]
- Updated dependencies [fd12c00]
- Updated dependencies [73baa49]
- Updated dependencies [29e39cc]
- Updated dependencies [c2d68cd]
- Updated dependencies [0915e8f]
  - @slate/shared@1.0.0
