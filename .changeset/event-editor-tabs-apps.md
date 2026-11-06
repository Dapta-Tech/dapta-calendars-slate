---
"@slate/web": minor
---

The event type editor is split into tabs (General, Booking form, Reminders, CRM Connection, AI Agents) that share one unsaved draft; the active tab is kept in the URL (`?tab=`), and CRM Connection shows only when a CRM adapter or tracking is available. General groups its settings under Basics, Availability, Hosts and calendars, After booking, and Visibility and sharing, and the questions invitees answer have their own Booking form tab; buffers, seats per time, booking window and slot interval sit behind "Advanced settings", which opens on its own when one of them is set or has an error. Duration is chosen with 15/30/45/60-minute chips or Custom, and the slot interval follows the duration while it matched it. Minimum notice is a choice from 1 hour to 5 days (a stored value outside the list stays as an extra choice, so it never changes on save).

Required fields carry a `*` and say "required" to assistive technology. Save is always clickable: a save with errors opens the first error's tab (and Advanced settings when needed), focuses the field, lists every error with its tab in a summary whose items go to their fields, and counts errors on each tab. A taken event link and a reminder template the API refuses point at their field the same way. Leaving with unsaved changes asks first. The AI Agents tab shows how an agent books the event: its ID, an example prompt and the MCP address, read-only.

`@slate/shared` adds the EN and ES copy under `admin.eventTypes.editor`; `components/ui/tabs.tsx` is a new WAI-ARIA tabs primitive, and `FormHeader` takes an optional `onBack`.
