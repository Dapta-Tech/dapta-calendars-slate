---
"@slate/db": patch
---

`listAccountSchedules` pages by keyset (`limit`, `after`, and a `next` position)
and can be limited to one member, so a read across an account never drops
schedules silently past a fixed cap.
