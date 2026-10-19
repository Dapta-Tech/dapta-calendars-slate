---
'@slate/shared': minor
---

Product analytics never forwards a campaign tag that is not a label. `analyticsCampaignValue` (new, with `CAMPAIGN_VALUE_MAX`) withholds a `utm_*` value that looks like an email address or handle, a URL (with or without its scheme), a query fragment, a scheme or port (any colon), a value encoded twice, an HTML entity or a phone number (with a leading `+` or in groups; one unbroken run of digits is kept, as it cannot be told from a campaign id), checked after Unicode compatibility folding and including percent-encoded and doubly encoded forms, or that runs past 100 characters. Labels such as "Q&A webinar" and "Video #2" pass. The API's `attribution_captured` event and account update send only the tags that pass, with `utm_withheld: true` on the event when one was held back. `referrerDomain` answers only host names a browser can send. Host browser events also drop a search engine's keyword (`ph_keyword`, `$search_engine`).
