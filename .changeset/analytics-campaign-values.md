---
'@slate/shared': minor
---

Product analytics never forwards a campaign tag that is not a label. New `analyticsCampaignValue` (and `CAMPAIGN_VALUE_MAX`): a `utm_*` value passes only if it is made of letters, digits, the space and a short list of punctuation (an allowlist, checked after Unicode compatibility folding) and is not an address, a URL or path, a colon not followed by a space, an HTML entity, a grouped or `+`-led phone number, or an encoding left twice; the exact rules are in its doc comment. An encoding left once is decoded and checked again. The API's `attribution_captured` event and account update send only the tags that pass, with `utm_withheld: true` on both when one was held back. `referrerDomain` answers only host names a browser can send. Host browser events also drop a search engine's keyword.
