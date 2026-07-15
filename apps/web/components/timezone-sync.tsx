'use client';

import { useEffect, useRef } from 'react';
import { syncTimeZoneAction } from '@/app/admin/timezone-actions';

/**
 * Reports the browser's real IANA timezone to the server exactly once per
 * mount — the server-side default ('UTC', the schema sentinel) is otherwise
 * never corrected, which is how a fresh host's "Working hours" schedule ends
 * up computed in the wrong timezone. Renders nothing; safe no-op once the
 * member already has an explicit timezone (see AdminService.syncClientTimeZone).
 */
export function TimeZoneSync({ currentTimeZone }: { currentTimeZone: string | null }) {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    if (currentTimeZone !== 'UTC') return; // already explicit — nothing to catch up
    let detected: string;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!detected || detected === 'UTC') return;
    sent.current = true;
    void syncTimeZoneAction(detected);
  }, [currentTimeZone]);

  return null;
}
