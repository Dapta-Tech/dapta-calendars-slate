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
