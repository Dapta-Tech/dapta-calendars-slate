'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { getMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';

/**
 * ConfirmDialog — the destructive-action confirmation, as a real dialog.
 *
 * Every destructive action in this admin confirms itself today by mutating the
 * row it is about to destroy: a `useState` pair swaps the Delete button for two
 * smaller buttons in the same 200px of a list row. Six sites do it, none traps
 * focus, none is announced, and none restores focus to the trigger — a keyboard
 * user tabs straight past the question and a screen-reader user is told nothing
 * happened. This asks properly: `role="alertdialog"`, focus trap, Esc/overlay =
 * cancel, focus restore, least-destructive control focused first.
 *
 * Ported from the Dapta Forms sheet (MIT, same owner), with three deviations:
 *
 *   1. `z-[70]`, above `Modal`'s `z-50` and the toast's `z-[60]`. A confirmation
 *      that renders UNDER the thing it asks about is worse than no confirmation,
 *      and modals in this app do contain actions. No call site raises one from
 *      inside a modal YET — both of today's are a list row and a card — so this
 *      is a guard for the sweeps, not a value any current screen exercises. The
 *      cost is that a toast fired while the dialog is open renders beneath it.
 *   2. The scrim is `bg-background/80 backdrop-blur-sm`, not Forms' raw
 *      `bg-black/60`. A raw colour is forbidden in product chrome and a black
 *      scrim is authored for one theme; `bg-background/80` is what `Modal`
 *      already uses and is theme-correct by construction. The blur is what does
 *      the separation work on light, where an 80% white scrim alone is weak.
 *   3. The confirm button keeps THIS repo's outline-red `destructive` variant,
 *      which is what all six existing inline confirms already paint. A solid red
 *      would make the dialog louder than the thing it replaced, and red is a
 *      reserved signal in this sheet.
 *   4. Cancel is `outline`, not Forms' `secondary`. Our `secondary` variant has
 *      zero call sites (noted in F, #80) and would arrive here untested; every
 *      inline confirm this component replaces already paints its Cancel as a
 *      bordered transparent button, which is exactly `outline`.
 *
 * Both buttons take `size="lg"` — `h-11`, the 44px step. `Button`'s default size
 * is `h-10` and would miss the mobile bar.
 *
 * Usage (call sites stay one-liner-ish):
 *   const { confirm, dialog } = useConfirmDialog(locale);
 *   ...
 *   if (!(await confirm({ title, message, destructive: true }))) return;
 *   ...
 *   return <>{ui}{dialog}</>;
 */
export interface ConfirmDialogOptions {
  title: string;
  message: string;
  /** Confirm button copy — defaults to the catalog's generic `dialog.confirm`. */
  confirmLabel?: string;
  /** Cancel button copy — defaults to the catalog's generic `dialog.cancel`. */
  cancelLabel?: string;
  /** Style the confirm button as a destructive (red) action. */
  destructive?: boolean;
}

interface ActiveConfirm extends ConfirmDialogOptions {
  resolve: (accepted: boolean) => void;
  /** Per-ask identity, so a superseding ask remounts rather than re-rendering. */
  id: number;
}

let askSeq = 0;

/** @param locale 'en' | 'es' — resolves the default confirm/cancel copy. */
export function useConfirmDialog(locale = 'en'): {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  const activeRef = useRef<ActiveConfirm | null>(null);

  const confirm = useCallback(
    (options: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        // A second ask while one is open replaces it; the superseded one cancels.
        // A hook that hands out promises has to answer every one of them.
        activeRef.current?.resolve(false);
        const next: ActiveConfirm = { ...options, resolve, id: ++askSeq };
        activeRef.current = next;
        setActive(next);
      }),
    [],
  );

  const close = useCallback((accepted: boolean) => {
    const current = activeRef.current;
    activeRef.current = null;
    setActive(null);
    current?.resolve(accepted);
  }, []);

  return {
    confirm,
    // Keyed on the ask: a superseding `confirm()` must REMOUNT, not re-render.
    // The mount effect is what focuses Cancel and captures the element to restore
    // focus to; re-rendering the same element would leave the second question
    // wearing the first one's focus state.
    dialog: active ? (
      <ConfirmDialog key={active.id} options={active} locale={locale} onClose={close} />
    ) : null,
  };
}

/** Everything focusable inside the dialog card (for the Tab cycle). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ConfirmDialog({
  options,
  locale,
  onClose,
}: {
  options: ConfirmDialogOptions;
  locale: string;
  onClose: (accepted: boolean) => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Least-destructive control gets initial focus, so a reflexive Enter cancels.
    cancelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(false);
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: Tab cycles within the card in both directions.
      const items = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!items || items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = cardRef.current?.contains(document.activeElement) ?? false;
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase so an open menu/modal underneath never sees the Escape.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  const dm = getMessages(locale).dialog;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => onClose(false)}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
      />
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        data-testid="confirm-dialog"
        className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5 text-card-foreground shadow-lg"
      >
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          {options.title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-muted-foreground">
          {options.message}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            size="lg"
            data-testid="confirm-dialog-cancel"
            onClick={() => onClose(false)}
          >
            {options.cancelLabel ?? dm.cancel}
          </Button>
          <Button
            variant={options.destructive ? 'destructive' : 'default'}
            size="lg"
            data-testid="confirm-dialog-confirm"
            onClick={() => onClose(true)}
          >
            {options.confirmLabel ?? dm.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
