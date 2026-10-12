'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { commonTimeZones, getMessages, readableZone } from '@slate/shared';

/**
 * The booking page's time zone control: a quiet line of text that opens a
 * combobox, drawn entirely by the `bp-*` contract so the host's ten axes and
 * both canvases reach every pixel of it.
 *
 * It replaces the admin `Select` on the public page only. That primitive is
 * built for the admin's palette: its selected row is a `bg-primary` slab, its
 * keyboard cursor is a rim in the primary, and its filter box drew the focus
 * outline as an accent hairline under itself. On a booking page all three read
 * as someone else's design language (Felipe's screenshot, 2026-10-12). The admin
 * keeps `TimeZoneSelect` untouched.
 *
 * What the visitor gets:
 *  - a search field with the form's own field anatomy (`bp-input`), focused on
 *    open, so typing filters at once;
 *  - rows 44px tall, the zone on the left and its offset as a figure on the
 *    right, so the offsets read as a column;
 *  - the selected zone marked by ink (a check and weight), never a filled slab;
 *  - the zone the times are shown in pinned at the top, and the visitor's own
 *    zone beside it when the two differ, each under a sticky group label;
 *  - a themed scrollbar only (R30 item 1);
 *  - the same control on a phone, where the list rises as a sheet over a dimmed
 *    page (the container query in globals.css decides, not the viewport);
 *  - type to filter, arrows, Home and End, Enter to choose, Escape to close.
 *    Escape stops there and never closes a dialog behind it.
 */

/** Current UTC offset for a zone, e.g. "GMT-5". Invalid zones omit it. */
export function zoneOffset(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** The browser's own zone, or null where it cannot be read. Client only. */
function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

interface Row {
  zone: string;
  label: string;
  offset: string;
}

interface Group {
  key: string;
  label: string | null;
  rows: Row[];
}

export function ZonePicker({
  id,
  value,
  onChange,
  locale = 'en',
  ariaLabel,
}: {
  id?: string;
  /** IANA zone the times are shown in. */
  value: string;
  onChange: (zone: string) => void;
  locale?: string;
  ariaLabel?: string;
}) {
  const messages = getMessages(locale);
  const m = messages.tzPicker;
  const bp = messages.bookingPage;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [local, setLocal] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-z${i}`;

  // The visitor's zone is read on open, not on render: the server cannot know
  // it, and reading it during render would make the HTML disagree on hydration.
  useEffect(() => {
    if (open) setLocal(browserZone());
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    if (!open) return [];
    const now = new Date();
    const row = (zone: string): Row => ({ zone, label: readableZone(zone), offset: zoneOffset(zone, now) });
    const q = query.trim().toLowerCase();
    const all = commonTimeZones(value);
    if (q) {
      const hits = all
        .map(row)
        .filter(
          (r) =>
            r.label.toLowerCase().includes(q) || r.zone.toLowerCase().includes(q) || r.offset.toLowerCase().includes(q),
        );
      return [{ key: 'hits', label: null, rows: hits }];
    }
    const pinned: Group[] = [{ key: 'current', label: bp.zoneCurrent, rows: [row(value)] }];
    if (local && local !== value) pinned.push({ key: 'local', label: bp.zoneLocal, rows: [row(local)] });
    const pinnedZones = new Set(pinned.flatMap((g) => g.rows.map((r) => r.zone)));
    return [...pinned, { key: 'all', label: bp.zoneAll, rows: all.filter((z) => !pinnedZones.has(z)).map(row) }];
  }, [open, query, value, local, bp.zoneCurrent, bp.zoneLocal, bp.zoneAll]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the keyboard cursor in view while arrowing. `nearest` so a row already
  // visible does not jump, and the list scrolls, never the page.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openPanel = () => {
    setQuery('');
    setActive(0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const choose = (zone: string) => {
    onChange(zone);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = flat.length - 1;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(a + 1, last));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Home':
        if (!query) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (!query) {
          e.preventDefault();
          setActive(last);
        }
        break;
      case 'Enter': {
        e.preventDefault();
        const r = flat[active];
        if (r) choose(r.zone);
        break;
      }
      default:
        break;
    }
  };

  // Focus leaving the control closes it, as a listbox should (APG).
  const onBlurCapture = (e: React.FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  let index = -1;
  return (
    <div ref={rootRef} className="bp-zone" onBlur={onBlurCapture}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="bp-zone-trigger"
      >
        <GlobeGlyph />
        <span className="bp-zone-name">{readableZone(value)}</span>
        <span className="bp-zone-offset">{zoneOffset(value)}</span>
        <svg aria-hidden viewBox="0 0 24 24" className="bp-zone-chevron" data-open={open ? 'true' : undefined}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <>
          {/* A tap on it is a tap outside. Only drawn on a phone (globals.css). */}
          <div aria-hidden className="bp-zone-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="bp-zone-panel" onKeyDown={onKeyDown}>
            <div className="bp-zone-search">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder={m.search}
                role="combobox"
                aria-label={m.search}
                aria-expanded
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={flat[active] ? optionId(active) : undefined}
                autoComplete="off"
                spellCheck={false}
                className="bp-input"
              />
            </div>
            <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="bp-zone-list">
              {groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.label ?? undefined}>
                  {g.label ? (
                    <div aria-hidden className="bp-zone-group">
                      {g.label}
                    </div>
                  ) : null}
                  {g.rows.map((r) => {
                    index += 1;
                    const i = index;
                    const selected = r.zone === value;
                    return (
                      <div
                        key={`${g.key}-${r.zone}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={selected}
                        data-index={i}
                        data-active={i === active ? 'true' : undefined}
                        className="bp-zone-row"
                        // Keep focus in the search field while the row is
                        // clicked, or the focus-loss close would unmount the
                        // list before the click lands (Safari, Firefox).
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(r.zone)}
                      >
                        <span className="bp-zone-mark" aria-hidden>
                          {selected ? <CheckGlyph /> : null}
                        </span>
                        <span className="bp-zone-row-name">{r.label}</span>
                        <span className="bp-zone-row-offset">{r.offset}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 ? <p className="bp-zone-empty">{m.noResults}</p> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function GlobeGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="bp-zone-globe">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
