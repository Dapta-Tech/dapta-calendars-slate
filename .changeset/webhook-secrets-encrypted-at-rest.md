---
'@slate/db': minor
---

Webhook signing secrets are encrypted at rest

`webhook.secret` was plain `text` in both dialects, readable by anyone with
database access. Unlike `api_key` it cannot be hashed — the signer has to read
it back to build the `X-Slate-Signature` HMAC — so it now rides the same
AES-256-GCM envelope the CRM credentials use (`v1.<iv>.<tag>.<ciphertext>`,
keyed by `INTEGRATION_ENCRYPTION_KEY`), in a new nullable `secret_cipher`
column.

The binding is its own AAD, `webhookSecretAad(accountId, webhookId)` —
`${accountId}:webhook:${webhookId}` — never the CRM's `secretAad`. A ciphertext
lifted into another webhook's row, another account, or the integration table
fails to decrypt rather than quietly signing deliveries with a secret it was
never sealed for.

A separate column rather than an in-place envelope on `secret`, because
`POST /v1/webhooks` accepts a caller-supplied secret: an in-place envelope would
have to infer "envelope or literal secret?" from the string's shape, and a
caller may legitimately supply one starting with `v1.`. A column makes "is this
encrypted" a schema fact. It also keeps every old row valid with no rewrite —
the migration adds a column and touches no data.

Decryption happens only at signing time, in the three places that build the
signature: `pingWebhook`, `dispatchWebhooks` and `deliverWebhookEvent`. No read
endpoint returns a secret, and `MatchingWebhook` no longer carries one.
`createWebhook` takes a required `key: Buffer`, so the compiler rather than a
runtime branch is what guarantees no call site writes plaintext.

Secret generation and the signature itself are unchanged: `whsec_` plus 24
random bytes, `sha256=<hex>` HMAC-SHA256 over the raw body.

When `INTEGRATION_ENCRYPTION_KEY` is absent, an existing plaintext secret keeps
working and signs exactly as it does today; a stored envelope refuses loudly
rather than falling through to an unsigned delivery; and creating a webhook
refuses with a coded `INTEGRATION_KEY_MISSING`, the same shape
`connectIntegration` already returns. Once a key is present, a legacy plaintext
row is re-sealed in place the first time it signs, with a byte-identical
signature. A deployment can never newly write a plaintext secret.

Additive migration in both dialects, order-independent.
