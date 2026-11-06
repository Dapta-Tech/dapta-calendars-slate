'use client';

import { useEffect, useState } from 'react';
import type { getMessages } from '@slate/shared';
import { BookingFlow } from '@/components/booking-flow';
import { previewFlowProps } from '@/components/booking-preview';
import { takeDraftPreview, type DraftPreview } from '@/app/admin/event-types/draft-preview';

type PreviewMessages = ReturnType<typeof getMessages>['admin']['eventTypes']['editor']['preview'];

/**
 * The editor's unsaved draft, drawn as the booking page and fully clickable:
 * the visitor's month, times and form, with the event's questions. Real times
 * when the event is saved (`realSlots`), example times otherwise. Picking a
 * time holds nothing and submitting books nothing (`previewNotice`). The
 * draft is read after mount, from the key the eye button left.
 */
export function DraftBookingPreview({
  hostName,
  avatarUrl,
  logoUrl,
  locale,
  realSlots,
  timeZone,
  m,
}: {
  hostName: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  locale: 'en' | 'es';
  realSlots: { startUtc: string }[] | null;
  timeZone: string;
  m: PreviewMessages;
}) {
  const [draft, setDraft] = useState<DraftPreview | null | undefined>(undefined);
  useEffect(() => {
    setDraft(takeDraftPreview(new URLSearchParams(window.location.search).get('k')));
  }, []);

  if (draft === undefined) return null;
  const sample = previewFlowProps({
    hostName,
    avatarUrl,
    logoUrl,
    locale,
    eventTitle: draft?.title || '…',
    description: draft?.description ?? null,
    lengthMinutes: draft && draft.lengthMinutes > 0 ? draft.lengthMinutes : 30,
    location: draft?.location ?? null,
    bookingFields: draft?.bookingFields ?? [],
  });
  return (
    <>
      <div
        role="note"
        data-testid="draft-preview-banner"
        className="mx-auto mb-group max-w-3xl rounded-md border border-border bg-card px-field py-inline text-center text-sm text-muted-foreground"
      >
        {!draft ? m.pageMissing : realSlots ? m.pageBannerReal : m.pageBanner}
      </div>
      {draft ? (
        <BookingFlow
          {...sample}
          {...(realSlots
            ? {
                slots: realSlots,
                initialTimeZone: timeZone,
                followBrowserZone: true,
                nowUtc: new Date().toISOString(),
              }
            : {})}
          previewNotice={m.bookingDisabled}
        />
      ) : null}
    </>
  );
}
