---
"@slate/web": patch
---

`docker-compose.prod.yml` now renders pages. The web container had no `API_URL`,
so the web server used the `NEXT_PUBLIC_API_URL` baked in at build
(`http://localhost:4000`), and every page rendered on the server called the web
container itself: booking pages and the dashboard showed the error page. The
file now sets `API_URL=http://api:4000` on the web, gives the API a healthcheck
on `/health/ready`, and starts the web only once that passes. `SELF-HOSTING.md`
and `.env.example` document `API_URL`, the address the web server calls, read at
runtime, and correct `NEXT_PUBLIC_API_URL`: it is only the built-in default for
it, fixed at build time; no browser code calls the API directly. CI now boots
this file from a clean tree and checks a booking page and a dashboard page.
