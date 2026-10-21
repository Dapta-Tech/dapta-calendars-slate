---
'@slate/db': minor
'@slate/notifications': minor
'@slate/shared': minor
'@slate/types': minor
---

Inviting a teammate now works end to end. The invite sends an email (English or Spanish, in the inviter's dashboard language, naming the product as the deployment names its mail) with an "Accept invitation" button to `/admin/join/{account code}`; the toast says "Invitation sent." only when the deployment really sends mail, says to pass the word on when it sends none, and says so when the email could not be queued. A pending invitation has a "Resend invite" button (at most once a minute per member); a workspace can send at most 50 invitation emails a day, new or resent, counted atomically in the database (new table `member_invite_quota`, its own additive migration); a queued invitation is skipped if the member was removed or already joined.

One person can belong to several workspaces. Someone who already has their own account sees the workspaces they were invited to in a switcher on the rail (shown from two workspaces, pending ones marked "Invited"); picking one accepts it. The email's link opens an invitation page with a Join button (signed out, through the login first); opening the link accepts nothing. Accepting turns the member active with the invited role and binds it to the person, so the MCP connection sees that workspace too. Someone signed in with another address is told the invitation is not theirs.

Under the hood a dashboard call may name its workspace in the `x-dcal-workspace` header; the API re-checks the membership on every call and honors only memberships an invitation granted (new column `member.invited_at`, additive, pending invitations backfilled). A workspace the person does not hold, or has not accepted, is a 403 (`WORKSPACE_FORBIDDEN`, `INVITATION_PENDING`); the web then drops the choice and opens their own account. Without the header nothing changes: API keys, the MCP door, public pages and forks behave exactly as before, and OAuth consent always acts for the home account. New analytics events `invite_sent` and `invite_accepted`. See ADR 0010.
