---
'@slate/shared': patch
---

Product analytics never forwards a campaign tag that is not a label. `analyticsCampaignValue` withholds a `utm_*` value that looks like an email address, a URL or a query fragment (including percent-encoded and doubly encoded forms) or runs past 100 characters, and the API's `attribution_captured` event and account update send only the tags that pass, with `utm_withheld: true` on the event when one was held back.
