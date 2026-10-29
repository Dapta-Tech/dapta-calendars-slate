---
"@slate/web": patch
---

English is the default language of every page for a fresh visitor. The browser's
`Accept-Language` no longer picks Spanish on its own: the booking pages, the
public surfaces and the admin (sign-in, onboarding) render in English unless the
visitor chose otherwise, with `?lang=es` on a public page or the language
switcher's saved choice in the admin. Explicit switching is unchanged.
