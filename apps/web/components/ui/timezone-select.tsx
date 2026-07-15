'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { commonTimeZones, getMessages } from '@slate/shared';
import { cn } from '@/lib/cn';

/**
 * TimeZoneSelect — a themed combobox replacing the native <select> for IANA
 * zones (QA2 fix 1). The native control hands the full ~400-entry list to the
 * OS popup: un-themeable, white, and on macOS it covers the whole screen. This
 * renders a token-styled trigger + a search-filterable panel anchored under
 * the field, capped in height.
 *
 * Same contract as the <select> it replaces: `value` is an IANA zone string,
 * `onChange` fires with the picked zone. Labels come from the shared i18n
 * catalog via `locale` (like DateTimePicker), so callers don't thread
 * messages through.
 */

/** Current UTC offset for a zone, e.g. "GMT-7" — picking is much easier with
 *  the offset in view. Invalid zones (shouldn't happen) just omit it. */
function zoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function TimeZoneSelect({
  value,
  onChange,
  locale = 'en',
  id,
  ariaLabel,
  className,
}: {
  /** IANA zone (e.g. 'America/Mexico_City'). */
  value: string;
  onChange: (tz: string) => void;
  /** 'en' | 'es' — anything getMessages accepts. */
  locale?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const m = getMessages(locale).tzPicker;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const zones = useMemo(() => commonTimeZones(value), [value]);
  // Offsets computed once per mount (they only shift on DST boundaries).
  const offsets = useMemo(() => new Map(zones.map((z) => [z, zoneOffset(z)])), [zones]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replaceAll(' ', '_');
    if (!q) return zones;
    return zones.filter(
      (z) => z.toLowerCase().includes(q) || (offsets.get(z) ?? '').toLowerCase().includes(query.trim().toLowerCase()),
    );
  }, [zones, offsets, query]);

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
    setActive(Math.max(0, zones.indexOf(value)));
    setOpen(true);
  };

  const pick = (tz: string) => {
    onChange(tz);
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
      const z = filtered[active];
      if (z) pick(z);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm transition-colors hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate">{value.replaceAll('_', ' ')}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {offsets.get(value) ?? ''}
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

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
          <ul ref={listRef} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto p-1">
            {filtered.map((z, i) => {
              const selected = z === value;
              return (
                <li key={z} role="option" aria-selected={selected} data-index={i}>
                  <button
                    type="button"
                    onClick={() => pick(z)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm',
                      selected
                        ? 'bg-primary text-primary-foreground'
                        : i === active
                          ? 'bg-muted'
                          : 'hover:bg-muted',
                    )}
                  >
                    <span className="truncate">{z.replaceAll('_', ' ')}</span>
                    <span
                      className={cn(
                        'shrink-0 text-xs',
                        selected ? 'text-primary-foreground/80' : 'text-muted-foreground',
                      )}
                    >
                      {offsets.get(z) ?? ''}
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
