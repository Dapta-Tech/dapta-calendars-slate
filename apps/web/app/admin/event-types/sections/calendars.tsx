'use client';

import Link from 'next/link';
import { type Connection } from '@/lib/admin-api';
import { connectionDisplayLabel } from '@/lib/connection-label';
import { cn } from '@/lib/cn';
import { buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { EventTypeMessages } from './shared';

/**
 * PHASE 2 — the EDITABLE "Calendars for this event" section (personal events
 * only; team events keep no per-event calendar config — Phase 3, each host
 * has their own connection and a single line here would be misleading).
 * Replaces the old read-only calendar-link notice (Felipe: "cómo está el
 * calendario conectado al evento, esto no hace sentido") with per-connection
 * "check for conflicts" + a single "add events here" destination choice.
 * Gracefully degrades: 0 connections → the connect-a-calendar hint; 1
 * connection → shown alone (both toggles default on, same as before).
 */
export function CalendarsForEventSection({
  connections,
  conflictIds,
  destinationId,
  onToggleConflict,
  onSetDestination,
  m,
}: {
  connections: Connection[];
  conflictIds: Set<string>;
  destinationId: string | null;
  onToggleConflict: (id: string) => void;
  onSetDestination: (id: string) => void;
  m: EventTypeMessages;
}) {
  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-start gap-field rounded-md border border-dashed border-border bg-background/60 p-field text-sm text-muted-foreground">
        <p>{m.calendarLinkNone}</p>
        <Link href="/admin/connections" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
          {m.calendarLinkConnect}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-field rounded-md border border-border bg-background/40 p-card">
      <div className="flex items-center justify-between gap-field">
        <span className="text-sm font-semibold text-muted-foreground">{m.calendarsSectionTitle}</span>
        <Link
          href="/admin/connections"
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'shrink-0')}
        >
          {m.calendarsManageLink}
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">{m.calendarsSectionHint}</p>
      <div className="flex flex-col gap-inline">
        <div className="flex items-center gap-field px-tight text-xs text-muted-foreground">
          <span className="flex-1" />
          <span className="w-28 text-center sm:w-32">{m.calendarsCheckConflicts}</span>
          <span className="w-28 text-center sm:w-32">{m.calendarsAddEventsHere}</span>
        </div>
        {connections.map((c) => {
          const label = connectionDisplayLabel(c);
          return (
            <div
              key={c.id}
              className="flex items-center gap-field rounded-md border border-border bg-card px-field py-inline"
            >
              <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                {label}
              </span>
              <label
                className="flex w-28 cursor-pointer justify-center sm:w-32"
                aria-label={`${label} — ${m.calendarsCheckConflicts}`}
              >
                <Checkbox checked={conflictIds.has(c.id)} onChange={() => onToggleConflict(c.id)} />
              </label>
              <label
                className="flex w-28 cursor-pointer justify-center sm:w-32"
                aria-label={`${label} — ${m.calendarsAddEventsHere}`}
              >
                <Radio
                  name="destinationCalendarId"
                  checked={destinationId === c.id}
                  onChange={() => onSetDestination(c.id)}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
