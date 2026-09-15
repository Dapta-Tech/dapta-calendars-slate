/**
 * Stand-in for the `server-only` package under vitest (see `vitest.config.ts`).
 *
 * `server-only` exists to make the BUILD fail when server code is imported into
 * a client bundle. It has no runtime behaviour and does not resolve outside a
 * Next build, so a spec that imports a server module cannot load without this.
 * Deliberately empty.
 */
export {};
