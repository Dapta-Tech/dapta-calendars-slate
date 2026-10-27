---
"@slate/api": minor
"@slate/web": patch
"@slate/shared": minor
---

The product reads as dCal. The site title and description now say what the
product is, calendars for AI agents ("{product}: calendars for AI agents",
"{product}: calendarios para agentes de IA"), instead of describing booking
pages. The API docs page and the served OpenAPI document are titled after the
deployment's product (`PRODUCT_NAME`, else the mail sender name, as the email
footer does) instead of a hardcoded "Dapta Calendars API", so a fork gets
"Calendars API". The setup checklist no longer names the old product, the
unused `poweredBy` string is gone, and the docs, README and agent guides use
dCal.
