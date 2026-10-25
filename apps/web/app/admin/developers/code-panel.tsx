'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The code blocks of the connect guide: a header with a label and a copy
 * button over a block that scrolls inside itself (a long URL or JSON line never
 * widens the page). JSON and shell commands get a light highlight from the
 * theme tokens, so they read the same in light and dark.
 */

export interface CopyLabels {
  copy: string;
  copied: string;
  copyFailed: string;
}

/**
 * Copies `text`; says so for two seconds, or says it could not. The button's
 * name stays what it copies; only the outcome is announced, once (the live
 * region empties again instead of going back to "Copy").
 */
export function CopyButton({
  text,
  label,
  m,
  testId,
}: {
  text: string;
  /** Accessible name while idle: what gets copied. */
  label: string;
  m: CopyLabels;
  testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  const shown = state === 'copied' ? m.copied : state === 'failed' ? m.copyFailed : m.copy;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      data-testid={testId}
      data-state={state}
      aria-label={label}
      title={label}
      className={cn(
        // A 44px target on a phone (R28), the panel's compact 32px from `sm` up.
        'inline-flex h-11 shrink-0 items-center gap-tight rounded-md px-inline text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] sm:h-8',
        state === 'copied'
          ? 'text-signal-ink'
          : state === 'failed'
            ? 'text-destructive'
            : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <i aria-hidden className={`pi ${state === 'copied' ? 'pi-check' : 'pi-copy'}`} style={{ fontSize: 12 }} />
      <span aria-hidden>{shown}</span>
      <span aria-live="polite" className="sr-only">
        {state === 'idle' ? '' : shown}
      </span>
    </button>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty JSON with keys, strings and literals told apart. */
export function highlightJson(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of code.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    const [whole, str, colon, literal, num] = match;
    if (str !== undefined && colon !== undefined) {
      out.push(
        <span key={i++} className="text-foreground">
          {str}
        </span>,
        colon,
      );
    } else if (str !== undefined) {
      out.push(
        <span key={i++} className="text-signal-ink">
          {str}
        </span>,
      );
    } else if (literal !== undefined || num !== undefined) {
      out.push(
        <span key={i++} className="text-warning-ink">
          {literal ?? num}
        </span>,
      );
    } else {
      out.push(whole);
    }
    last = at + whole.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const SHELL_TOKEN = /(\$[A-Z][A-Z0-9_]*)|(^|\s)(--?[A-Za-z][A-Za-z-]*)/gm;

/** A shell command with its flags quieter and its shell variables marked. */
export function highlightShell(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of code.matchAll(SHELL_TOKEN)) {
    const at = match.index ?? 0;
    const [whole, variable, space, flag] = match;
    if (at > last) out.push(code.slice(last, at));
    if (variable !== undefined) {
      out.push(
        <span key={i++} className="text-warning-ink">
          {variable}
        </span>,
      );
    } else if (flag !== undefined) {
      out.push(
        space ?? '',
        <span key={i++} className="text-faint">
          {flag}
        </span>,
      );
    }
    last = at + whole.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodePanel({
  label,
  code,
  language,
  copyLabel,
  m,
  wrap,
  testId,
}: {
  label: string;
  code: string;
  language: 'json' | 'shell' | 'text';
  copyLabel: string;
  m: CopyLabels;
  /** Wrap long lines instead of scrolling them: for prose, like a prompt. */
  wrap?: boolean;
  testId?: string;
}) {
  const body = language === 'json' ? highlightJson(code) : language === 'shell' ? highlightShell(code) : code;
  return (
    <div data-testid={testId} className="min-w-0 overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex min-h-10 items-center justify-between gap-inline border-b border-border py-tight pl-field pr-tight">
        <span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-faint">{label}</span>
        <CopyButton text={code} label={copyLabel} m={m} testId={testId ? `${testId}-copy` : undefined} />
      </div>
      <pre
        className={cn(
          'max-w-full overflow-x-auto p-field font-mono text-xs leading-relaxed text-muted-foreground',
          wrap && 'whitespace-pre-wrap break-words',
        )}
      >
        <code>{body}</code>
      </pre>
    </div>
  );
}
