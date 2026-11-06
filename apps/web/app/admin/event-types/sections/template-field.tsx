'use client';

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/cn';

/**
 * A text field whose `{{variables}}` show as chips. The VALUE stays the plain
 * template string the API stores (`Intro – {{attendee_name}}`): chips are only
 * how it is drawn. Text is typed as usual; a variable arrives by dropping a
 * chip from the palette (the browser drops `{{name}}` as text, which turns
 * into a chip), by clicking one (inserted at the caret), or by typing
 * `{{name}}` by hand. Backspace removes a chip whole.
 *
 * A contentEditable region, kept in step with `value` without fighting the
 * caret: the DOM is rebuilt only when it no longer says what `value` says, or
 * when raw `{{…}}` text needs to become a chip, and the caret is put back at
 * the same place in the template.
 */

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type TemplateSegment = { text: string } | { token: string };

/** The template as text and variable segments, in order. */
export function parseTemplateSegments(value: string): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let at = 0;
  for (const m of value.matchAll(TOKEN_RE)) {
    if (m.index! > at) out.push({ text: value.slice(at, m.index) });
    out.push({ token: m[1]!.trim() });
    at = m.index! + m[0].length;
  }
  if (at < value.length) out.push({ text: value.slice(at) });
  return out;
}

const isChip = (n: Node): n is HTMLElement => n instanceof HTMLElement && !!n.dataset.token;
const chipText = (el: HTMLElement) => `{{${el.dataset.token}}}`;

/** The template a field's DOM says: text as typed, each chip as `{{name}}`. */
export function serializeTemplateDom(root: Node): string {
  let out = '';
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
    else if (isChip(n)) out += chipText(n);
    else if (n.nodeName === 'BR') out += '\n';
    else out += serializeTemplateDom(n);
  });
  return out;
}

/** Where the caret is, as an offset into the serialized template (null if outside). */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.endContainer, range.endOffset);
  const holder = document.createElement('div');
  holder.appendChild(pre.cloneContents());
  return serializeTemplateDom(holder).length;
}

/** Put the caret at an offset of the serialized template (a chip is one step). */
function placeCaret(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let left = offset;
  for (const n of Array.from(root.childNodes)) {
    const len = n.nodeType === Node.TEXT_NODE ? (n.textContent ?? '').length : isChip(n) ? chipText(n).length : 0;
    if (left <= len) {
      if (n.nodeType === Node.TEXT_NODE) range.setStart(n, left);
      else if (left === 0) range.setStartBefore(n);
      else range.setStartAfter(n);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    left -= len;
  }
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export interface ChipLook {
  label: string;
  /** `answer` for booking-form answers, `unknown` for a name nothing resolves. */
  kind: 'answer' | 'builtin' | 'unknown';
}

export const chipClass = (kind: ChipLook['kind']) =>
  cn(
    'mx-px inline-flex select-none items-center rounded-full border px-inline align-baseline text-xs font-medium leading-5',
    kind === 'answer' && 'border-signal-edge/60 bg-signal/15 text-foreground',
    kind === 'builtin' && 'border-primary/30 bg-primary/10 text-foreground',
    kind === 'unknown' && 'border-destructive/50 bg-destructive/10 text-destructive',
  );

function render(root: HTMLElement, value: string, look: (token: string) => ChipLook) {
  root.replaceChildren(
    ...parseTemplateSegments(value).map((s) => {
      if ('text' in s) return document.createTextNode(s.text);
      const { label, kind } = look(s.token);
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.dataset.token = s.token;
      chip.className = chipClass(kind);
      chip.textContent = label;
      chip.title = `{{${s.token}}}`;
      return chip;
    }),
  );
}

/** Whether any text node still holds a raw `{{…}}` that should be a chip. */
function hasRawToken(root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\{\{\s*[^{}]+?\s*\}\}/.test(n.textContent ?? '')) return true;
  }
  return false;
}

export interface TemplateFieldHandle {
  /** Insert `{{token}}` where the caret was last in the field (or at its end). */
  insert: (token: string) => void;
}

export const TemplateField = forwardRef<
  TemplateFieldHandle,
  {
    id: string;
    value: string;
    onChange: (next: string) => void;
    onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
    onFocus?: () => void;
    look: (token: string) => ChipLook;
    multiline?: boolean;
    placeholder?: string;
    maxLength?: number;
    labelledBy: string;
    describedBy?: string;
    invalid?: boolean;
    className?: string;
  }
>(function TemplateField(
  { id, value, onChange, onBlur, onFocus, look, multiline = false, placeholder, maxLength, labelledBy, describedBy, invalid, className },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const lastCaret = useRef<number | null>(null);
  const lookRef = useRef(look);
  lookRef.current = look;

  // Bring the DOM in line with `value` when something else changed it (the
  // first render, a reset); never while it already says the same thing.
  useLayoutEffect(() => {
    const el = root.current;
    if (el && serializeTemplateDom(el) !== value) render(el, value, lookRef.current);
  }, [value]);

  const emit = () => {
    const el = root.current!;
    let next = serializeTemplateDom(el);
    if (maxLength && next.length > maxLength) next = next.slice(0, maxLength);
    if (hasRawToken(el) || next !== serializeTemplateDom(el)) {
      const at = caretOffset(el) ?? next.length;
      render(el, next, lookRef.current);
      placeCaret(el, Math.min(at, next.length));
    }
    lastCaret.current = caretOffset(el);
    onChange(next);
  };

  /** `restore`: put the caret back where the host left it first (a palette
   *  click moved focus away, and focusing again may land the caret anywhere). */
  const insertText = (text: string, restore = false) => {
    const el = root.current!;
    const sel = window.getSelection();
    if (restore || !sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).startContainer)) {
      placeCaret(el, lastCaret.current ?? serializeTemplateDom(el).length);
    }
    const range = window.getSelection()!.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    emit();
  };

  useImperativeHandle(ref, () => ({
    insert: (token: string) => {
      root.current?.focus();
      insertText(`{{${token}}}`, true);
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (multiline) insertText('\n');
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    insertText(multiline ? text : text.replace(/[\r\n]+/g, ' '));
  };

  const remember = () => {
    if (root.current) lastCaret.current = caretOffset(root.current) ?? lastCaret.current;
  };

  return (
    <div
      id={id}
      ref={root}
      role="textbox"
      aria-multiline={multiline || undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={emit}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onKeyUp={remember}
      onMouseUp={remember}
      onBlur={(e) => {
        remember();
        onBlur?.(e);
      }}
      className={cn(
        'w-full cursor-text whitespace-pre-wrap break-words rounded-md border border-input bg-background px-field py-inline text-sm leading-7 transition-colors hover:border-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
        multiline ? 'min-h-24' : 'min-h-control',
        invalid && 'border-destructive',
        className,
      )}
    />
  );
});
