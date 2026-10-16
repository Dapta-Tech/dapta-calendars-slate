'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { adminBookingPath, legacyBookingHashUid } from '@slate/shared';

/**
 * Request emails sent before a booking had its own page linked to the list
 * with the uid in the fragment (`/admin/bookings#booking-<uid>`). A fragment
 * never reaches the server, so only the browser can read it: this moves such a
 * link to the booking's own page, which opens it whatever the list holds.
 *
 * `replace`, so Back does not return to the list only to be moved again.
 * Renders nothing; without script the list itself is still a sensible landing.
 */
export function LegacyBookingLink() {
  const router = useRouter();
  useEffect(() => {
    const uid = legacyBookingHashUid(window.location.hash);
    if (uid) router.replace(adminBookingPath(uid));
  }, [router]);
  return null;
}
