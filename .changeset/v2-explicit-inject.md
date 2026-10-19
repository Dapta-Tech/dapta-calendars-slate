---
"@slate/api": patch
---

Fix the `/v2` agent API rejecting every valid API key with `401 INVALID_API_KEY`.
`CalV2Controller` was the only class without explicit `@Inject` tokens, and the
API runs on tsx, which emits no decorator metadata, so its three dependencies
were `undefined` at request time. A new guard test walks every controller and
provider in `AppModule` and fails when a constructor parameter has no token.
