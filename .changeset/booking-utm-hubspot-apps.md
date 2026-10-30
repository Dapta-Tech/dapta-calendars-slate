---
'@slate/web': minor
'@slate/api': minor
---

The booking's campaign (its `utm_*`) reaches the CRM.

- The meeting written to the CRM lists the booking's UTMs, one `utm_*: value` line per key it kept, before the booking reference. A booking without UTMs adds no line.
- The event type editor's CRM mapping offers a Campaign (UTM) group, EN and ES, with the five `utm_*` keys, so a host can write `utm_source` and the rest to the contact properties of their choice: a text property, or a single-choice dropdown whose option matches the value. The save refuses a campaign key aimed at any other type, as it does for answers.
- A team booking now keeps its campaign before its CRM write-out is queued, as a personal booking already did, so the write-out never runs without it.
