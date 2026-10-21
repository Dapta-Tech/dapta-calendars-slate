---
"@slate/shared": minor
---

Catalog keys for the copy fixes in MCP, Connect and keys, in both locales. New:
`admin.common.openNav`, `admin.common.primaryNav` and `admin.common.accountSwitcher`
(the mobile menu button, the nav's name and the operator account picker, until
now English only); `admin.developer.webhookEventLabels` (the webhook form's
event names, by the wire name after `booking.`, which stays as it is);
`admin.developer.toolNeedsAnyKeyOrSignIn`; `signInCursorLead`,
`signInClaudeCodeNext` and `signInOtherLead` (the sign-in setups with no key);
`guideKeyUsedDone`, `guideKeyAltTitle` and `guideKeyAltBody` (the guide's key
step when people sign in through an external server). Changed: `signInTitle`
reads "Sign in from your app" (it now titles the guide's first step), and the
Claude and ChatGPT steps say the MCP address is above, where it is. A fork that
maintains its own locale object literal against `BookingMessages` adds these
keys to keep compiling.
