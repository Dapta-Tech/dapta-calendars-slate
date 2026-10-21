---
"@slate/config": minor
---

The API holds an idle keep-alive connection for `KEEP_ALIVE_TIMEOUT`
milliseconds (default `65000`, at most a day; an empty value counts as unset),
with a headers deadline one second above it, instead of Node's 5 s default. A
load balancer that reuses its connections to the API (60 s on AWS ALB) is then
always the side that closes an idle one, so it never sends a request down a
socket the API is closing and answers that visitor with a 502. The server env
schema gains the variable. It is the name the web's Next standalone server
already reads, so one variable configures both apps. Nothing else changes:
unset, the API only keeps idle sockets open longer.
