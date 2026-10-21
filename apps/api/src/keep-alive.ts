import type { Server } from 'node:http';

/**
 * Hold idle keep-alive connections open for `keepAliveMs`.
 *
 * A load balancer reuses its connections to the API, and it must always be the
 * side that closes an idle one. If the API closes first (Node's default is
 * 5 s, an AWS ALB keeps 60 s), the balancer can send the next request down a
 * socket that is already closing and answer the visitor with a 502.
 *
 * `headersTimeout` is kept above `keepAliveTimeout`, the conventional pairing
 * behind a load balancer: older Node versions counted the headers deadline
 * from when a reused socket went idle. Node reads both live (the idle window
 * again as each response finishes), so setting them right after `listen` is
 * enough.
 */
export function applyKeepAliveTimeout(server: Server, keepAliveMs: number): void {
  server.keepAliveTimeout = keepAliveMs;
  server.headersTimeout = keepAliveMs + 1000;
}
