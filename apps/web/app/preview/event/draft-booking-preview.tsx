'use client';

import { useEffect, useState } from 'react';
import type { getMessages } from '@slate/shared';
import { BookingFlow } from '@/components/booking-flow';
import { previewFlowProps } from '@/components/booking-preview';
import { takeDraftPreview, type DraftPreview } from '@/app/admin/event-types/draft-preview';

type PreviewMessages = ReturnType<typeof getMessages>['admin']['eventTypes']['editor']['preview'];

/**
 * The editor's unsaved draft, drawn as the booking page: the real island with
 * sample times, at full size, inert (a picture of the page: nothing books).
 * The draft is read after mount, from the key the eye button left.
 */
export function DraftBookingPreview({
  hostName,
  avatarUrl,
  logoUrl,
  locale,
  m,
}: {
  hostName: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  locale: 'en' | 'es';
  m: PreviewMessages;
}) {
  const [draft, setDraft] = useState<DraftPreview | null | undefined>(undefined);
  useEffect(() => {
    setDraft(takeDraftPreview(new URLSearchParams(window.location.search).get('k')));
  }, []);

  if (draft === undefined) return null;
  return (
    <>
      <div
        role="note"
        data-testid="draft-preview-banner"
        className="mx-auto mb-group max-w-3xl rounded-md border border-border bg-card px-field py-inline text-center text-sm text-muted-foreground"
      >
        {draft ? m.pageBanner : m.pageMissing}
      </div>
      {draft ? (
        <div aria-hidden="true" inert>
          <BookingFlow
            {...previewFlowProps({
              hostName,
              avatarUrl,
              logoUrl,
              locale,
              eventTitle: draft.title || '…',
              description: draft.description,
              lengthMinutes: draft.lengthMinutes > 0 ? draft.lengthMinutes : 30,
              location: draft.location,
              bookingFields: draft.bookingFields,
            })}
          />
        </div>
      ) : null}
    </>
  );
}
