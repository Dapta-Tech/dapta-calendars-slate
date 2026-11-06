---
"@slate/shared": major
---

**Breaking for code that types its own locale objects as `BookingMessages`:** the interface gains required members (`admin.eventTypes.editor`, with every new key the editor reads), so such an object must add them to compile. The shipped `en` and `es` catalogs carry them.

EN and ES copy for the tabbed event type editor under `admin.eventTypes.editor` (tabs, required marks, errors and summary, advanced settings, duration and minimum notice, unsaved changes, the AI Agents tab). See `event-editor-tabs-apps.md`.
