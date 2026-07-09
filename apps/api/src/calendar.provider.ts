/**
 * The CalendarProvider seam. The external-calendar integration is resolved
 * through the pluggable `CalendarProvider` port (`@slate/calendar`) selected by
 * `CALENDAR_PROVIDER` (config/env), so the enum is genuinely load-bearing:
 *
 *   - `disabled` — the OSS default. No external calendar: availability subtracts
 *                  only local bookings + holds, and bookings write nothing out.
 *                  A bare clone runs with zero calendar config.
 *   - `external` — a concrete adapter (Google/Outlook conferencing + free-busy)
 *                  that ships in the PRIVATE deploy overlay (`deploy/`, gitignored)
 *                  and is wired by replacing this factory. NO vendor is named in
 *                  the public build (R15). Selecting `external` in the pure OSS
 *                  build fails loud rather than silently disabling calendar sync.
 *
 * This mirrors the AuthProvider seam (`auth.provider.ts`): the port lives in a
 * public package, the OSS default is safe, and the private adapter is an
 * env-selected drop-in that never leaks into the open-source surface.
 */
import { DisabledCalendarProvider, type CalendarProvider } from '@slate/calendar';
import type { ServerEnv } from '@slate/config/env';

/** Select the CalendarProvider for the configured `CALENDAR_PROVIDER`. */
export function createCalendarProvider(env: ServerEnv): CalendarProvider {
  switch (env.CALENDAR_PROVIDER) {
    case 'disabled':
      return new DisabledCalendarProvider();
    case 'external':
      throw new Error(
        'CALENDAR_PROVIDER=external requires the private calendar adapter overlay (deploy/), which is not ' +
          'bundled in the open-source build. Provide a concrete CalendarProvider or use CALENDAR_PROVIDER=disabled.',
      );
    default:
      throw new Error(`Unknown CALENDAR_PROVIDER: ${String((env as ServerEnv).CALENDAR_PROVIDER)}`);
  }
}
