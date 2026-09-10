'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Modal } from '@/components/modal';
import { embedSnippet } from '@/lib/embed';

type EmbedMessages = BookingMessages['embed'];

/**
 * The copy-paste snippet dialog (E).
 *
 * ONE control, on purpose: an accent picker that starts on "use my booking page
 * style". #67 settled this — putting all nine appearance axes in here clones
 * the studio inside a dialog for a case that is overwhelmingly "make the button
 * match my site". The other nine are named in `advancedNote` so a host who
 * wants them can hand-add them to the address.
 */
export function EmbedSnippetModal({
  open,
  onClose,
  publicPath,
  title,
  messages: m,
}: {
  open: boolean;
  onClose: () => void;
  /** The public booking path, e.g. `/acme/alex-rivera/intro-call`. */
  publicPath: string;
  /** Goes into the iframe's `title` — what a screen reader announces for it. */
  title: string;
  messages: EmbedMessages;
}) {
  const [useAccent, setUseAccent] = useState(false);
  const [accent, setAccent] = useState('#1a73e8');
  const [copied, setCopied] = useState(false);

  /**
   * The real origin, resolved after mount. The server cannot know it — this
   * component renders inside the admin, which is reachable on several hosts —
   * and the snippet is worthless with a relative `src`, since it is pasted onto
   * somebody else's site. Rendered as the path until then, so SSR and the first
   * client render agree (the same trick `CopyLink` uses).
   */
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  // Per instance. The event-types list mounts one of these per row, and only
  // the open one is in the DOM — but a shared literal id is a duplicate waiting
  // for the first caller that renders two at once.
  const labelId = useId();

  const snippet = useMemo(
    () =>
      embedSnippet({
        origin,
        publicPath,
        brandColor: useAccent ? accent : null,
        title,
      }),
    [origin, publicPath, useAccent, accent, title],
  );

  // A snippet the host edited under one accent must not still say "Copied"
  // when they change it. Reset on every input to the generated text.
  useEffect(() => setCopied(false), [snippet]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      /* clipboard blocked — the textarea below is selectable, so there is
         still a way to get the snippet out. */
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={m.title} labelId={labelId}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{m.intro}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{m.accentLabel}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="embed-accent"
              checked={!useAccent}
              onChange={() => setUseAccent(false)}
            />
            <span>{m.accentInherit}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="embed-accent"
              checked={useAccent}
              onChange={() => setUseAccent(true)}
            />
            <span>{m.accentCustom}</span>
            <input
              type="color"
              value={accent}
              aria-label={m.accentCustom}
              onChange={(e) => {
                setAccent(e.target.value);
                // Touching the swatch is the same statement as choosing the
                // radio beside it; making the host click both is busywork.
                setUseAccent(true);
              }}
              className="h-7 w-10 cursor-pointer rounded-sm border border-border bg-background"
            />
          </label>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{m.snippetLabel}</span>
          <textarea
            readOnly
            data-modal-autofocus
            value={snippet}
            rows={7}
            onFocus={(e) => e.currentTarget.select()}
            className="rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs"
          />
        </label>

        <p className="text-xs text-muted-foreground">{m.resizeNote}</p>
        <p className="text-xs text-muted-foreground">{m.advancedNote}</p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {copied ? m.copied : m.copy}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary"
          >
            {m.close}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The `</>` mark. Inline and `currentColor`, like every other row action. */
export function EmbedIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 18-6-6 6-6" />
      <path d="m15 6 6 6-6 6" />
    </svg>
  );
}
