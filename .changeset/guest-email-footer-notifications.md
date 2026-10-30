---
'@slate/notifications': minor
'@slate/db': minor
---

The invitee's "Made with" footer matches the booking page's badge: the attribution itself is a link, the link carries the account's public code as `utm_content` (new optional `BookingNotification.accountCode`, filled from `BookingNotificationContext.accountCode`), and the plain-text part ends with the same line. A notifier given `signupBaseUrl` tags the link per message.

A transport that appends its own support footer (`EmailProvider.addsSupportFooter`, true on the `transactional-v1` HTTP wire) no longer gets the layout's "This is an automated message. Need help?" line as well, and each message now carries its language (`EmailMessage.locale`), which that wire forwards so the service's footer matches the recipient.
