---
'@slate/shared': minor
---

`--sp-tight` (4px) joins the spacing scale.

The sweep is what proved it was needed: 72 half-step utilities (`py-0.5`,
`gap-1.5`, `px-2.5`) had nowhere on the 4px grid to land, and rounding all of them
up to 8px would have visibly fattened every badge and chip in the admin.

`--sp-roomy` was tried and dropped in the same pass. Its 19 call sites turned out
to be dialogs, which the scale already calls `group`, and button padding, which is
what `--sp-control-x` is for — a value bucket, not a role.
