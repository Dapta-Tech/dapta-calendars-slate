---
'@slate/shared': patch
---

Add the i18n copy the `Select` and `ConfirmDialog` primitives own (reskin slice P).

Two new top-level catalog blocks, siblings of `tzPicker` and `phonePicker` — the
shape this catalog already uses for a shared primitive that carries its own copy
so callers never thread it through:

- `select` — `search`, `noResults`
- `dialog` — `confirm`, `cancel`

Plus four keys on `admin.teams` (`deleteTitle`, `deleteBody`, `removeTitle`,
`removeBody`) for the two destructive confirmations that become real dialogs. The
inline two-button confirm they replace never asked a question, so the question is
new copy. Both bodies interpolate `{name}`.

EN and ES; the `BookingMessages` interface enforces parity. Additive only.
