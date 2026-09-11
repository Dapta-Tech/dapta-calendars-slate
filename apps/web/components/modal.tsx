'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Everything focusable inside the card (for the Tab cycle). Mirrors
 *  `confirm-dialog.tsx`, which has had the trap since P (#97). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: backdrop, Esc-to-close, `role=dialog` +
 * `aria-labelledby`, autofocus, focus TRAP, page scroll lock, and focus restore
 * to the opener.
 *
 * A2 (#112) added the last three, and fixed the effect that made the first two
 * misbehave. Both were reachable only once this component started hosting
 * dialogs a person TYPES in:
 *
 *  - **The effect re-ran on every render.** Its deps were `[open, onClose]`, and
 *    every call site passes a fresh arrow each render, so each keystroke in a
 *    field inside the dialog tore the effect down — pulling focus back to the
 *    opener — and set it up again, re-focusing the autofocus target. With one
 *    call site that had no text field this never showed. `onClose` now lives in
 *    a ref and the effect depends on `open` alone, so it runs exactly twice per
 *    open/close.
 *  - **There was no focus trap and no scroll lock**, despite `aria-modal="true"`
 *    telling assistive tech there was one. Tab walked out of the dialog into the
 *    page behind it, and on a phone the page scrolled under the backdrop.
 */
export function Modal({
  open,
  onClose,
  title,
  labelId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  labelId: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Read at event time, so a per-render handler cannot re-trigger the effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!items || items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = ref.current?.contains(document.activeElement) ?? false;
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    // Scroll lock, restoring whatever the page had rather than assuming ''.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // `data-modal-autofocus` wins where a dialog knows which control the person
    // came for; otherwise the first control, as before. A dialog that opens
    // with explanatory checkboxes above its real field would otherwise focus
    // one of those.
    (
      ref.current?.querySelector<HTMLElement>('[data-modal-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('input, select, textarea, button')
    )?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-card">
      <button type="button" aria-hidden tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-background/80" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-popover p-group shadow-lg"
      >
        <h2 id={labelId} className="mb-card text-lg font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
