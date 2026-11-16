---
'@slate/web': patch
---

Booking prefill: every `name`, `email`, `notes` and `answer_*` parameter is now removed from the address even when its value was refused (overlong or invalid), so an invitee's text never stays in the URL the host's tags read. A required number question accepts only a plain decimal from a prefill, so `0x10`, `1e3` or `Infinity` no longer pass the required check while the input submits blank.
