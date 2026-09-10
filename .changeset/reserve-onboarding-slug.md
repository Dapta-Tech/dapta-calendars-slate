---
'@slate/engine': patch
---

Reserve `onboarding` as a public slug. It was the one top-level product path an account could still claim as its vanity slug, and with the inline embed's framing policy that is no longer only a routing collision: the account's booking page would be served from a path the framing rule reads as the dashboard, so it would answer `frame-ancestors 'self'` and its embed would render a blocked frame on every host site with no error anywhere.
