---
"@slate/api": patch
---

The API reference reads its configured addresses more carefully. A
`PUBLIC_APP_URL` that carries a query or fragment no longer drops the API keys
link and the page icon: the reference keeps its origin and path. The MCP
address is normalized the way the dashboard shows it (no trailing slash) and
left out when it carries credentials, a query or a fragment.
