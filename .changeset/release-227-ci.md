---
"@slate/api": patch
---

The internal web-to-API secret (`INTERNAL_API_SECRET`, the header that vouches for a
visitor's address) is compared byte for byte with `timingSafeEqual` instead of hashing
both sides with SHA-256 first. The compare stays constant-time in the value sent; a
value of a different length is refused after the same amount of work, which can reveal
only the secret's length. A visitor, a forged header and no header are told apart
exactly as before. This clears the CodeQL `js/insufficient-password-hash` alert on the
release PR (#227).
