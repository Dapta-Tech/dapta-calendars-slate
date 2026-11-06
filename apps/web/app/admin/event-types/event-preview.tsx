'use client';

import { useDeferredValue, useEffect, useId, useState } from 'react';
import { renderTemplate, type TemplateValues } from '@slate/engine';
import { formatLead } from '@slate/shared';
import type { BookingField, EventReminder } from '@slate/types';
import { BookingPreview, PreviewFrame } from '@/components/booking-preview';
import { usePublicOrigin } from '@/components/public-origin';
import type { EventPreviewHost } from '@/lib/event-preview';
import type { EventTypeMessages } from './sections/shared';

export interface PreviewDraft {
  title: string;
  slug: string;
  description: string;
  lengthMinutes: number;
  location: { kind: string; detail?: string | null } | null;
  bookingFields: BookingField[];
  reminders: EventReminder[];
}

/** The browser window the preview sits in: three dots and the page's address. */
function BrowserChrome({ address }: { address: string }) {
  return (
    <div className="flex items-center gap-inline border-b border-border bg-muted/40 px-field py-inline">
      <span aria-hidden className="flex gap-tight">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
      </span>
      <span
        data-testid="et-preview-address"
        className="min-w-0 flex-1 truncate rounded-full border border-border bg-background px-field py-tight font-mono text-xs text-muted-foreground"
      >
        {address}
      </span>
    </div>
  );
}

/** Sample values the reminder preview fills its variables with (never real data). */
/** The sample meeting's start: the preview's own fixed morning (see `PREVIEW_NOW`). */
const SAMPLE_START = Date.UTC(2026, 8, 10, 9, 0);
const when = (ms: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(ms);

function sampleValues(
  d: PreviewDraft,
  hostName: string,
  m: EventTypeMessages['editor']['preview'],
  lead: string,
  locale: string,
) {
  const values: Record<string, string> = {
    attendee_name: m.sampleAttendee,
    attendee_first_name: m.sampleAttendee.split(' ')[0] ?? m.sampleAttendee,
    attendee_email: 'sam@example.com',
    host_name: hostName,
    event_title: d.title,
    event_name: d.title,
    event_description: d.description,
    duration: `${d.lengthMinutes} min`,
    location: d.location?.detail ?? '',
    start_time: when(SAMPLE_START, locale),
    end_time: when(SAMPLE_START + (Number.isFinite(d.lengthMinutes) ? d.lengthMinutes : 30) * 60_000, locale),
    time_zone: 'UTC',
    reminder_lead: lead,
    meeting_url: 'https://meet.example.com/abc-defg',
    manage_url: 'https://example.com/booking/manage',
  };
  for (const f of d.bookingFields) values[`form.${f.name}`] = m.sampleAnswer;
  return values as TemplateValues;
}

/** One reminder as the attendee would read it, with sample values. */
function ReminderEmail({
  draft,
  hostName,
  locale,
  m,
}: {
  draft: PreviewDraft;
  hostName: string;
  locale: 'en' | 'es';
  m: EventTypeMessages['editor']['preview'];
}) {
  const pickId = useId();
  const rows = draft.reminders;
  const [picked, setPicked] = useState(0);
  if (rows.length === 0) {
    return <p className="p-card text-sm text-muted-foreground">{m.noReminders}</p>;
  }
  const at = Math.min(picked, rows.length - 1);
  const row = rows[at]!;
  let n = 0;
  const labels = rows.map((r) => (r.kind === 'follow_up' ? m.followUp : m.reminderN.replace('{n}', String(++n))));
  const values = sampleValues(draft, hostName, m, formatLead(row.leadMinutes, locale), locale);
  const subject = row.subject?.trim() ? renderTemplate(row.subject, values, { mode: 'line', locale }) : null;
  const body = row.body?.trim() ? renderTemplate(row.body, values, { mode: 'text', locale }) : null;
  return (
    <div className="flex flex-col gap-field p-card">
      {rows.length > 1 ? (
        <label htmlFor={pickId} className="flex flex-col gap-tight text-sm text-muted-foreground">
          {m.reminderPick}
          <select
            id={pickId}
            value={at}
            onChange={(e) => setPicked(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-inline py-tight text-sm text-foreground"
          >
            {rows.map((r, i) => (
              <option key={r.id} value={i}>
                {labels[i]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <article data-testid="et-preview-email" className="flex flex-col gap-inline rounded-md border border-border bg-background p-card">
        <p className="text-xs text-muted-foreground">sam@example.com</p>
        {subject ? (
          <h3 className="text-base font-semibold text-foreground">{subject}</h3>
        ) : (
          <p className="text-sm italic text-muted-foreground">{m.defaultSubject}</p>
        )}
        {body ? (
          <p className="whitespace-pre-line text-sm text-foreground">{body}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">{m.defaultBody}</p>
        )}
      </article>
    </div>
  );
}

/**
 * The editor's live preview: the REAL booking page (the island the public page
 * renders, inert, with sample times) drawn from the unsaved draft inside a
 * browser frame with the event's address — or, on the Reminders tab, the
 * selected reminder as the attendee reads it. Updates are deferred, so typing
 * never waits on the page's render.
 */
export function EventPreview({
  draft,
  host,
  mode,
  locale,
  m,
  notShown,
}: {
  draft: PreviewDraft;
  host: EventPreviewHost;
  mode: 'page' | 'reminders';
  locale: 'en' | 'es';
  m: EventTypeMessages['editor']['preview'];
  /** Draft settings the sample page does not draw, named so nothing pretends. */
  notShown: string[];
}) {
  const d = useDeferredValue(draft);
  const origin = usePublicOrigin();
  const [address, setAddress] = useState('');
  useEffect(() => {
    // The origin is read in the browser (usePublicOrigin); the path is the draft's.
    const path = host.basePath ? `${host.basePath}/${d.slug || '…'}` : `/${d.slug || '…'}`;
    setAddress(`${origin()}${path}`.replace(/^https?:\/\//, ''));
  }, [host.basePath, d.slug, origin]);

  return (
    <div className="flex flex-col gap-inline">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <BrowserChrome address={address} />
        {mode === 'reminders' ? (
          <ReminderEmail draft={d} hostName={host.hostName} locale={locale} m={m} />
        ) : (
          // The phone layout: at the width of a side column it reads at full
          // size, where the desktop page would be zoomed out to unreadable.
          <PreviewFrame accent={host.accent} axes={host.axes} device="mobile" wide={false}>
            <BookingPreview
              hostName={host.hostName}
              avatarUrl={host.avatarUrl}
              logoUrl={host.logoUrl}
              eventTitle={d.title || '…'}
              description={d.description.trim() || null}
              lengthMinutes={Number.isFinite(d.lengthMinutes) && d.lengthMinutes > 0 ? d.lengthMinutes : 30}
              location={d.location}
              bookingFields={d.bookingFields}
              locale={locale}
              device="mobile"
            />
          </PreviewFrame>
        )}
      </div>
      {mode === 'page' && notShown.length > 0 ? (
        <p className="text-xs text-muted-foreground">{m.notShown.replace('{items}', notShown.join(', '))}</p>
      ) : null}
    </div>
  );
}
