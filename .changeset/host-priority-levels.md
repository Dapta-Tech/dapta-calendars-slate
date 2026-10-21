---
"@slate/shared": patch
---

A round robin host's priority is now a level, not a bare number. The team
event editor offers Lowest, Low, Medium, High and Highest per host, stored as
-2 to 2 in the existing `priority` column, which the host selector already
ranks by (the highest priority free host gets the booking). Medium is 0, the
value every host has today and the one new hosts start with, so every
existing event reads Medium and assignment does not change. No schema change
and no migration.

A priority set through the API outside -2 to 2 is shown as a "Custom (n)"
option that cannot be picked, and the editor keeps saving that value until
someone picks a level. A one-line hint under Hosts says who a booking goes
to. Below the `sm` width the host rows stack, each control with its own
label, so priority, weight and the fixed switch fit at 360px. New copy in EN
and ES under `admin.eventTypes.priorityHint` and
`admin.eventTypes.priorityLevels`.
