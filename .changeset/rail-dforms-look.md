---
"@slate/shared": patch
---

The admin sidebar looks and behaves like the dForms one. The rail sits on the
sidebar ground and is pinned to the viewport with its own scroll, so the
footer stays in view. It opens with the "dCal." wordmark (the mark when
collapsed and under 360px), then the account card for staff who can switch,
then the nav. The current row carries a wash and a 2px accent bar. The foot is
the theme switch (its icon now shows the current theme, as on dForms) and one
profile button (initial, name, email) whose menu holds the public page and Sign
out, pinned in view when the nav scrolls. A "Dapta Agents" door ends the list when the
deployment has a platform URL, and the app switcher calls the platform by the
same name. Every rail popup (the MCP menu, the app
switcher, the account picker, the profile menu) now opens outside the rail, so
nothing is clipped, and answers the menu keys (arrows, Home, End, Tab, Escape). New catalog strings: `admin.nav.agents`,
`admin.common.accountMenu`.
