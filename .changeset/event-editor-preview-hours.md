---
"@slate/shared": minor
"@slate/db": minor
"@slate/notifications": minor
"@slate/engine": patch
---

Groundwork for the editor's previews and custom hours (see `event-editor-preview-hours-apps.md`). `@slate/notifications`: `BookingNotifier.previewReminder` renders a reminder or follow-up exactly as it would be sent, through the same builders `sendReminder` and `sendFollowUp` use, without sending; `formatLead` now comes from `@slate/shared`, re-exported unchanged. `@slate/shared`: `formatLead`, and EN/ES copy for the previews and the availability editor. `@slate/db`: `listSchedules` marks the member's default schedule (`isDefault`). `@slate/engine`: `preview` is a reserved public slug, since `/preview` is now a product path.
