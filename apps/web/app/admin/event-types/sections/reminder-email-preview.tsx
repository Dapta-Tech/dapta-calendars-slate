'use client';

import { useId, useState } from 'react';
import type { EventReminder } from '@slate/types';
import { Modal } from '@/components/modal';
import { previewReminderAction, type ReminderPreviewPayload } from '../actions';
import type { EventTypeMessages } from './shared';

/** The event's draft facts a reminder preview renders around (unsaved values). */
export type ReminderPreviewContext = Omit<ReminderPreviewPayload, 'kind' | 'leadMinutes' | 'subject' | 'body'>;

type PreviewState = { status: 'loading' } | { status: 'ready'; subject: string; html: string } | { status: 'error' };

/**
 * "Preview email": the reminder as the invitee receives it — the real subject
 * and the real branded HTML, rendered by the API's own email builders from the
 * row's UNSAVED copy and a sample booking. Shown in a sandboxed frame (no
 * scripts, no navigation of this page), so the mail's markup and links stay
 * inside it.
 */
export function ReminderEmailPreview({
  row,
  context,
  m,
}: {
  row: EventReminder;
  context: ReminderPreviewContext;
  m: EventTypeMessages['editor']['preview'];
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const labelId = useId();

  const show = async () => {
    setOpen(true);
    setState({ status: 'loading' });
    const r = await previewReminderAction({
      ...context,
      kind: row.kind,
      leadMinutes: row.leadMinutes,
      subject: row.subject?.trim() ? row.subject : null,
      body: row.body?.trim() ? row.body : null,
    });
    setState(r.ok ? { status: 'ready', subject: r.subject, html: r.html } : { status: 'error' });
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="inline-flex cursor-pointer items-center gap-tight self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        <i aria-hidden className="pi pi-eye" style={{ fontSize: 14 }} />
        {m.emailButton}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={m.emailTitle} labelId={labelId}>
        <div className="flex flex-col gap-field" data-testid="et-email-preview">
          <p className="text-xs text-muted-foreground">{m.emailNote}</p>
          {state.status === 'loading' ? <p className="text-sm text-muted-foreground">{m.emailLoading}</p> : null}
          {state.status === 'error' ? <p className="text-sm text-destructive">{m.emailError}</p> : null}
          {state.status === 'ready' ? (
            <>
              <p className="text-sm">
                <span className="text-muted-foreground">{m.subjectLabel}: </span>
                <span className="font-semibold text-foreground" data-testid="et-email-subject">
                  {state.subject}
                </span>
              </p>
              <iframe
                title={m.emailTitle}
                // Scripts stay blocked; same-origin only so the frame can be
                // sized to the email instead of leaving a blank tail.
                sandbox="allow-same-origin"
                srcDoc={state.html}
                data-testid="et-email-frame"
                onLoad={(e) => {
                  const doc = e.currentTarget.contentDocument;
                  if (doc?.body) e.currentTarget.style.height = `${Math.min(doc.documentElement.scrollHeight, 720)}px`;
                }}
                className="h-[60vh] w-full rounded-md border border-border bg-white"
              />
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
