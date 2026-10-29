---
"@slate/web": patch
---

The "Learn more" beside "Custom links are included with your Dapta AI
subscription" in the booking page settings now links to
`NEXT_PUBLIC_PLATFORM_URL`, the same destination as the branding setting's
"Included with your Dapta AI subscription", instead of
`NEXT_PUBLIC_SIGNUP_URL`. The signup URL now only drives the "Made with"
links (badge, confirmation, profile and team CTAs, and, through the API's
fallback, the invitee email footer), so a deployment can send those to its
product site without moving the subscription link. Unset, the sentence stays
plain text, as before.
