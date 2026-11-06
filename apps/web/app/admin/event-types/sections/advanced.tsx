'use client';

import { useId, type ReactNode } from 'react';
import type { EventTypeDraft } from '../draft';
import { ChevronIcon, type EventTypeMessages } from './shared';

/** The settings that live behind "Advanced settings", and whether any is set. */
export function advancedSummary(
  d: Pick<EventTypeDraft, 'beforeBuf' | 'afterBuf' | 'seats' | 'windowDays' | 'slotInterval' | 'lengthMinutes'>,
  m: EventTypeMessages['editor']['advanced'],
): { custom: boolean; text: string } {
  const parts: string[] = [];
  const fill = (template: string, n: number | '') => template.replace('{n}', String(n));
  if (Number(d.beforeBuf) > 0) parts.push(fill(m.bufferBefore, d.beforeBuf));
  if (Number(d.afterBuf) > 0) parts.push(fill(m.bufferAfter, d.afterBuf));
  if (d.seats !== '' && Number(d.seats) > 1) parts.push(fill(m.seats, d.seats));
  if (d.windowDays !== '') parts.push(fill(m.window, d.windowDays));
  // "Same as the duration" is the default interval; anything else is a choice.
  if (d.slotInterval !== '' && d.slotInterval !== d.lengthMinutes) parts.push(fill(m.interval, d.slotInterval));
  return { custom: parts.length > 0, text: parts.length ? parts.join(' · ') : m.allDefault };
}

/**
 * A disclosure for the power-user settings. Collapsed, it says what is set
 * ("10 min before · up to 30 days ahead") so nothing hides silently. The
 * content stays MOUNTED while collapsed: a save that finds an error inside
 * opens it and focuses the field, which must already exist.
 */
export function AdvancedSettings({
  open,
  onToggle,
  summary,
  m,
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  summary: string;
  m: EventTypeMessages['editor']['advanced'];
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <section className="flex flex-col gap-field border-t border-border pt-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onToggle(!open)}
        className="-mx-tight flex min-h-control items-start gap-inline rounded-md px-tight text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mt-tight text-muted-foreground">
          <ChevronIcon direction={open ? 'up' : 'down'} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-foreground">{m.title}</span>
          <span className="text-xs text-muted-foreground">{open ? m.hint : summary}</span>
        </span>
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col gap-field">
        {children}
      </div>
    </section>
  );
}
