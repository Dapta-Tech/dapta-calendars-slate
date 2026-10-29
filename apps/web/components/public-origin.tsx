'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';

/**
 * The origin public booking links name in the dashboard (copy, open, embed):
 * the booking host when booking pages have one (`bookingOrigin()`, read on the
 * server at request time, never baked into the bundle), else this page's own
 * origin, as before.
 */
const PublicOriginContext = createContext<string | null>(null);

export function PublicOriginProvider({ origin, children }: { origin: string | null; children: ReactNode }) {
  return <PublicOriginContext.Provider value={origin}>{children}</PublicOriginContext.Provider>;
}

/** A function, so it is called in an event or an effect, where `window` exists. */
export function usePublicOrigin(): () => string {
  const origin = useContext(PublicOriginContext);
  return useCallback(() => origin ?? window.location.origin, [origin]);
}

/** A public path as a link: absolute on the booking host when there is one, else as given. */
export function usePublicHref(): (path: string) => string {
  const origin = useContext(PublicOriginContext);
  return useCallback((path: string) => (origin ? `${origin}${path}` : path), [origin]);
}
