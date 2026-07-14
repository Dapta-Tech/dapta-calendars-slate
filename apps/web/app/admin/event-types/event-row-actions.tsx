'use client';

import { useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/toast';
import { toggleEventTypeHiddenAction } from './actions';

type EventTypesMessages = BookingMessages['admin']['eventTypes'];

const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground';

/**
 * Per-row quick actions for an event type (QA3 fix 4c, cal.com-style):
 * visibility switch + open-public ↗ + copy-link. `publicPath` is null when the
 * event has no public URL yet (member without a handle / team without a slug) —
 * then only the switch renders.
 */
export function EventRowActions({
  id,
  hidden,
  publicPath,
  messages: m,
}: {
  id: string;
  hidden: boolean;
  publicPath: string | null;
  messages: EventTypesMessages;
}) {
  const [pending, start] = useTransition();
  // Optimistic: flip instantly, revert if the server action fails. On success
  // the revalidated `hidden` prop converges with this state.
  const [visible, setVisible] = useState(!hidden);
  const { success, error } = useToast();

  const onToggle = (next: boolean) => {
    setVisible(next);
    start(async () => {
      const r = await toggleEventTypeHiddenAction(id, !next);
      if (r.ok) success(next ? m.eventShown : m.eventHidden);
      else {
        setVisible(!next);
        if (r.message) error(r.message);
      }
    });
  };

  const copy = async () => {
    if (!publicPath) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${publicPath}`);
      success(m.linkCopied);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <span className="flex items-center gap-1.5">
      <Switch
        checked={visible}
        onCheckedChange={onToggle}
        disabled={pending}
        aria-label={m.toggleVisible}
        className="mr-1"
      />
      {publicPath ? (
        <>
          <a
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={m.openPublic}
            title={m.openPublic}
            className={iconButton}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </a>
          <button type="button" onClick={copy} aria-label={m.copyLink} title={m.copyLink} className={iconButton}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </>
      ) : null}
    </span>
  );
}
