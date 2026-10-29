---
"@slate/web": minor
"@slate/api": minor
---

Every booking keeps the campaign it came from: the five `utm_*` of the booking page's address or, embedded, of the page that frames it (all or nothing, never a mix). The page passes its own; an embedded page without any asks `embed.js` on the framing page, which answers only frames it placed, at the origin that asked, with its own page's five `utm_*`. The public booking writes (personal and team) store them cleaned (`booking.utm`, never refusing a booking over them), answer them, and put them on the `booking.created` webhook.

The redirect after booking can carry the booking to the host's thank-you page, Calendly's "pass event details": a choice under the address in the event editor, none (the address as typed, the default), the event (`event_type`, `event_type_name`, `event_start_time`, `event_end_time`, `booking_status`, `assigned_to` and the UTMs), or the event plus the invitee's name and email, with a line saying where those end up. Never the answers, the booking uid or the booking's title.
