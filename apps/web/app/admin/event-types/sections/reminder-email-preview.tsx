'use client';

import { useId, useState } from 'react';
import type { EventReminder } from '@slate/types';
import { Modal } from '@/components/modal';
import { previewReminderAction, type ReminderPreviewPayload } from '../actions';
import type { EventTypeMessages } from './shared';

/** The event's draft facts a reminder preview renders around (unsaved values). */
export type ReminderPreviewContext = Omit<ReminderPreviewPayload, 'kind' | 'leadMinutes' | 'subject' | 'body'>;

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; from: string | null; to: string; subject: string; html: string }
  | { status: 'error' };

/**
 * The eye button on a reminder: the email as the invitee receives it — the real subject
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
    setState(r.ok ? { status: 'ready', from: r.from, to: r.to, subject: r.subject, html: r.html } : { status: 'error' });
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label={m.emailButton}
        title={m.emailButton}
        data-testid="et-email-eye"
        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <i aria-hidden className="pi pi-eye" style={{ fontSize: 14 }} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={m.emailTitle} labelId={labelId}>
        <div className="flex flex-col gap-field" data-testid="et-email-preview">
          <p className="text-xs text-muted-foreground">{m.emailNote}</p>
          {state.status === 'loading' ? <p className="text-sm text-muted-foreground">{m.emailLoading}</p> : null}
          {state.status === 'error' ? <p className="text-sm text-destructive">{m.emailError}</p> : null}
          {state.status === 'ready' ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-field gap-y-tight border-b border-border pb-inline text-sm">
                {state.from ? (
                  <>
                    <dt className="text-muted-foreground">{m.fromLabel}</dt>
                    <dd className="min-w-0 truncate text-foreground">{state.from}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{m.toLabel}</dt>
                <dd className="min-w-0 truncate text-foreground">{state.to}</dd>
                <dt className="text-muted-foreground">{m.subjectLabel}</dt>
                <dd className="min-w-0 font-semibold text-foreground" data-testid="et-email-subject">
                  {state.subject}
                </dd>
              </dl>
              <iframe
                title={m.emailTitle}
                // Scripts stay blocked; same-origin only so the frame can be
                // sized to the email instead of leaving a blank tail.
                sandbox="allow-same-origin"
                srcDoc={state.html}
                data-testid="et-email-frame"
                onLoad={(e) => {
                  const frame = e.currentTarget;
                  const body = frame.contentDocument?.body;
                  if (!body) return;
                  // The mail's own content, not the frame's viewport: a layout
                  // table set to fill the window would otherwise report the
                  // frame's height back.
                  frame.style.height = '0px';
                  const content = Math.max(
                    ...[...body.children].map((c) => c.getBoundingClientRect().bottom),
                    body.scrollHeight,
                  );
                  frame.style.height = `${Math.min(Math.ceil(content) + 24, 720)}px`;
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
