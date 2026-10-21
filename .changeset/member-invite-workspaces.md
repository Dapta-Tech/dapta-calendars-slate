---
'@slate/db': minor
'@slate/notifications': minor
'@slate/shared': minor
'@slate/types': minor
---

Inviting a teammate now works end to end. The invite sends an email (English or Spanish, in the inviter's dashboard language) with an "Accept invitation" button to `/invite/{account code}`; the toast says "Invitation sent." only when the deployment really sends mail, and says to pass the word on otherwise. A pending invitation has a "Resend invite" button (at most once a minute per member); a queued invitation is skipped if the member was removed or already joined.

One person can belong to several workspaces. Someone who already has their own account sees the workspaces they were invited to in a switcher on the rail (shown from two workspaces, pending ones marked "Invited"), and opening one accepts the invitation: the member turns active, keeps the role they were invited with, and is bound to the person so the MCP connection sees that workspace too. The invitation link does the same after sign-in, and tells someone signed in with another address that the invitation is not theirs.

Under the hood a dashboard call may name its workspace in the `x-dcal-workspace` header; the API re-checks the membership on every call and answers 403 `WORKSPACE_FORBIDDEN` for one the person does not hold (the web then drops the choice and opens their own account). Without the header nothing changes: API keys, the MCP door, public pages and forks behave exactly as before. No migration. New analytics events `invite_sent` and `invite_accepted`. See ADR 0010.
