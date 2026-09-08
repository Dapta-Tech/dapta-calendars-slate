'use client';

import { type ReactNode, useTransition } from 'react';
import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { createDefaultScheduleAction } from '@/app/admin/availability/actions';
import { Button } from './ui/button';

export interface SetupStatus {
  hasConnectedCalendar: boolean;
  hasWorkingHours: boolean;
  hasPublishedEventType: boolean;
}

type HomeMessages = BookingMessages['admin']['home'];

/**
 * The Home "Get bookable" first-run guide (F1 §2). Driven entirely by REAL
 * setup state (AdminService.setupStatus) — never a static nag: each row shows
 * real done/todo, a one-click action to close the gap, and the whole card
 * disappears once every step is real (R22: instant, no dead ends).
 */
export function SetupChecklist({
  status,
  messages: m,
}: {
  status: SetupStatus;
  messages: HomeMessages;
}) {
  // The third step is "does this host have something to book", NOT "does a URL
  // exist" — every member gets an auto-handle, so the old check was true for
  // everyone while the page it pointed at rendered nothing (#84).
  const eventDone = status.hasPublishedEventType;
  if (status.hasConnectedCalendar && status.hasWorkingHours && eventDone) return null;

  return (
    <div className="mb-8 flex flex-col gap-3 rounded-md border border-border bg-card p-5">
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{m.setupTitle}</span>
        <span className="text-sm text-muted-foreground">{m.setupSubtitle}</span>
      </div>

      <ChecklistRow
        done={status.hasConnectedCalendar}
        title={m.setupConnectTitle}
        desc={m.setupConnectDesc}
        doneLabel={m.setupDone}
        action={
          <Link
            href="/admin/connections"
            className="text-sm font-medium text-primary underline underline-offset-4"
          >
            {m.setupConnectAction}
          </Link>
        }
      />

      <ChecklistRow
        done={status.hasWorkingHours}
        title={m.setupHoursTitle}
        desc={m.setupHoursDesc}
        doneLabel={m.setupDone}
        action={<CreateWorkingHoursInline label={m.setupHoursAction} />}
      />

      {/* Offering a copy button here was the same lie in UI form: it handed the
          host a link to an empty page. The gap is closed by publishing an event,
          so that is what the action does. */}
      <ChecklistRow
        done={eventDone}
        title={m.setupEventTitle}
        desc={m.setupEventDesc}
        doneLabel={m.setupDone}
        action={
          <Link
            href="/admin/event-types"
            className="text-sm font-medium text-primary underline underline-offset-4"
          >
            {m.setupEventAction}
          </Link>
        }
      />
    </div>
  );
}

function ChecklistRow({
  done,
  title,
  desc,
  action,
  doneLabel,
}: {
  done: boolean;
  title: string;
  desc: string;
  action: ReactNode;
  doneLabel: string;
}) {
  return (
    <div className="flex flex-col items-start justify-between gap-3 rounded-md border border-border/60 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ' +
            (done
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border text-transparent')
          }
        >
          ✓
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{desc}</span>
        </div>
      </div>
      <div className="shrink-0 pl-9 sm:pl-0">
        {done ? <span className="text-xs text-muted-foreground">{doneLabel}</span> : action}
      </div>
    </div>
  );
}

/** Same one-click NO_SCHEDULE fix as the New-booking empty state, surfaced on Home. */
function CreateWorkingHoursInline({ label }: { label: string }) {
  const [pending, startT] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => startT(async () => { await createDefaultScheduleAction(); })}
    >
      {pending ? '…' : label}
    </Button>
  );
}
