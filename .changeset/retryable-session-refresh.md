---
"@slate/shared": minor
---

Add the retryable session-refresh copy (`admin.session`) in English and Spanish.
It is deliberately separate from `login.error`: it is shown when the identity
service could not be reached while renewing a session, where nothing is wrong
with the person's credentials and they are still signed in, so the copy must not
imply they need to sign in again.
