'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, countryName, getMessages, type Country } from '@slate/shared';
import { cn } from '@/lib/cn';

/**
 * PhoneField — country dial-code selector + digits-only number input emitting
 * a single E.164-style value (QA3 fix 2). Replaces the bare
 * `<input type="tel">`, which accepted letters and gave attendees no dial-code
 * guidance. Same combobox pattern as TimeZoneSelect: themed trigger +
 * search-filterable panel capped in height, ↑↓/Enter/Esc keyboard support,
 * click-outside close.
 *
 * `value` is the full number including the dial code ('+525512345678') or ''
 * — consumers store and submit exactly what the attendee picked, no separate
 * country state to thread through.
 */

const US = COUNTRIES.find((c) => c.code === 'US')!;

/** Longest dial code that prefixes the value — '' when none matches. Longest
 *  wins so '+52…' never resolves to a shorter shared prefix. */
function longestDialPrefix(value: string): string {
  if (!value.startsWith('+')) return '';
  let best = '';
  for (const c of COUNTRIES) {
    if (c.dial.length > best.length && value.startsWith(c.dial)) best = c.dial;
  }
  return best;
}

/** Subscriber digits after the dial code — '' when the value is empty. */
export function phoneSubscriberDigits(value: string): string {
  const dial = longestDialPrefix(value);
  return (dial ? value.slice(dial.length) : value).replace(/\D/g, '');
}

/** True when a value has SOME digits but too few (<4) to be a number — the
 *  same rule the field flags inline, exported so form gates stay in sync. */
export function isPhoneValueTooShort(value: string): boolean {
  const d = phoneSubscriberDigits(value);
  return d.length > 0 && d.length < 4;
}

/** Country a value implies. Shared dials (+1 is US/CA/…) are ambiguous:
 *  keep the already-picked country when it fits, else fall back to US. */
function deriveCountry(value: string, pickedCode: string): Country {
  const picked = COUNTRIES.find((c) => c.code === pickedCode) ?? US;
  const dial = longestDialPrefix(value);
  if (!dial || picked.dial === dial) return picked;
  const candidates = COUNTRIES.filter((c) => c.dial === dial);
  return candidates.find((c) => c.code === 'US') ?? candidates[0] ?? picked;
}

export function PhoneField({
  value,
  onChange,
  locale = 'en',
  id,
  ariaLabel,
  name,
  required,
}: {
  /** Full number including dial code ('+525512345678'), or ''. */
  value: string;
  onChange: (v: string) => void;
  /** 'en' | 'es' — anything getMessages accepts. */
  locale?: string;
  id?: string;
  ariaLabel?: string;
  /** When set, a hidden input carries the full value into FormData submits. */
  name?: string;
  required?: boolean;
}) {
  const m = getMessages(locale).phonePicker;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pickedCode, setPickedCode] = useState('US');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const country = useMemo(() => deriveCountry(value, pickedCode), [value, pickedCode]);
  const digits = useMemo(() => phoneSubscriberDigits(value), [value]);
  const tooShort = digits.length > 0 && digits.length < 4;

  // Localized names once per locale; the list sorts by them so attendees scan
  // alphabetically in their own language, not by ISO code.
  const names = useMemo(
    () => new Map(COUNTRIES.map((c) => [c.code, countryName(c.code, locale)])),
    [locale],
  );
  const sorted = useMemo(
    () =>
      [...COUNTRIES].sort((a, b) =>
        (names.get(a.code) ?? a.code).localeCompare(names.get(b.code) ?? b.code, locale),
      ),
    [names, locale],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    const qDial = q.startsWith('+') ? q : `+${q}`;
    return sorted.filter(
      (c) =>
        (names.get(c.code) ?? c.code).toLowerCase().includes(q) ||
        c.code.toLowerCase() === q ||
        (/^\+?\d+$/.test(q) && c.dial.startsWith(qDial)),
    );
  }, [sorted, names, query]);

  // Close on outside click / Escape; focus search on open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    searchRef.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active option scrolled into view while arrowing through the list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openPanel = () => {
    setQuery('');
    setActive(Math.max(0, sorted.findIndex((c) => c.code === country.code)));
    setOpen(true);
  };

  const pick = (c: Country) => {
    setPickedCode(c.code);
    // Re-prefix the kept subscriber digits with the new dial code.
    onChange(digits ? `${c.dial}${digits}` : '');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[active];
      if (c) pick(c);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={m.countryLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openPanel())}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden>{country.flag}</span>
          <span className="text-muted-foreground">{country.dial}</span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <input
          id={id}
          aria-label={ariaLabel}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          required={required}
          value={digits}
          onChange={(e) => {
            // Digits only, capped at the E.164 subscriber maximum.
            const d = e.target.value.replace(/\D/g, '').slice(0, 14);
            onChange(d ? `${country.dial}${d}` : '');
          }}
          aria-invalid={tooShort || undefined}
          className={cn(
            'w-full flex-1 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tooShort ? 'border-destructive' : 'border-input',
          )}
        />
      </div>
      {tooShort ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {m.invalid}
        </p>
      ) : null}

      {open ? (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder={m.search}
            aria-label={m.search}
            className="border-b border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          <ul ref={listRef} role="listbox" aria-label={m.countryLabel} className="max-h-64 overflow-y-auto p-1">
            {filtered.map((c, i) => {
              const selected = c.code === country.code;
              return (
                <li key={c.code} role="option" aria-selected={selected} data-index={i}>
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                      selected
                        ? 'bg-primary text-primary-foreground'
                        : i === active
                          ? 'bg-muted'
                          : 'hover:bg-muted',
                    )}
                  >
                    <span aria-hidden className="shrink-0">
                      {c.flag}
                    </span>
                    <span className="truncate">{names.get(c.code) ?? c.code}</span>
                    <span
                      className={cn(
                        'ml-auto shrink-0 text-xs',
                        selected ? 'text-primary-foreground/80' : 'text-muted-foreground',
                      )}
                    >
                      {c.dial}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="px-2 py-3 text-sm text-muted-foreground">{m.noResults}</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
