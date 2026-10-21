---
'@slate/db': patch
---

The one-a-minute limit on resending an invitation now holds across every instance of the API and across restarts. It used to live in each process's memory, so with two replicas (or after a restart) quick resends could each queue an email, up to the workspace's daily cap to one person. It is now claimed in the database with one conditional update of `member.invited_at` (when an invitation last went out), and handed back only when the email could not be queued. Only a row that came from an invitation can be claimed, so a send never creates the mark that makes a membership reachable from another account's session; a member set back to invited by hand gets no email (409). No migration.
