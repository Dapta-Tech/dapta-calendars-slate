'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getMessages } from '@slate/shared';
import { cn } from '@/lib/cn';

/**
 * Select — a token-styled listbox replacing the OS-native `<select>` across the
 * admin. A native control hands its popup to the operating system: unthemeable,
 * drawn in the user agent's own colours at the user agent's own row height, and
 * on the light theme it is the one piece of another design language on the page.
 * F's `color-scheme` declaration keeps that popup from being *dark* on paper —
 * it is a floor, not a fix. This renders a token-styled trigger
 * (`border-input`/`bg-background`) plus a panel anchored under the field
 * (`border-border`/`bg-popover`/`shadow-lg`), so a dropdown follows the theme
 * with zero CSS changes.
 *
 * Ported from the Dapta Forms sheet (MIT, same owner), which generalized it from
 * THIS repo's `TimeZoneSelect`: same interaction shell (optional search filter,
 * ↑/↓/Enter/Esc, click-outside, scroll-into-view, listbox ARIA) but
 * options-array-driven and domain-agnostic. It comes home with three deviations,
 * all of them Calendars conventions rather than Forms ones:
 *
 *   1. A `locale` prop, not a client-side locale helper. `lib/locale.ts` is
 *      `server-only` here and every client component takes its copy as props.
 *      `TimeZoneSelect` and `PhoneField` already settle the shape for a
 *      primitive that owns its OWN copy: `locale = 'en'`, `getMessages` inside.
 *   2. The 44px mobile bar. Forms' trigger is ~38px and its rows ~32px; a row
 *      inside a popup is a touch target like any other, so both take
 *      `min-h-[44px]`. The panel shows fewer rows before it scrolls, which it
 *      already did.
 *   3. A `title` prop, so a disabled picker can say WHY on hover (the last owner
 *      of a team cannot be demoted). Without it, adopting this component would
 *      delete an explanation.
 *
 * Contract mirrors a `<select>`: `value` is the selected option's value and
 * `onChange` fires with the picked value. Controlled only — there is deliberately
 * no `name`/uncontrolled mode until a call site needs one. `searchable` (default
 * false) reveals a filter input for long lists.
 *
 * `className` styles the trigger button (matching the `Input` convention);
 * control width is set by the parent container, and the panel matches the
 * trigger width.
 */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  searchable = false,
  disabled = false,
  id,
  ariaLabel,
  title,
  className,
  locale = 'en',
}: {
  /** The selected option's value. */
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
  /** Reveal a filter input for long option lists. Default false. */
  searchable?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  /** Native tooltip on the trigger — how a disabled picker explains itself. */
  title?: string;
  /** Applied to the trigger button (matches the Input convention). */
  className?: string;
  /** 'en' | 'es' — resolves the search / no-results copy. */
  locale?: string;
}) {
  const m = getMessages(locale).select;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Stable ids so the focused element can point at the row the cursor is on —
  // without it a screen reader is told the list exists but never which row
  // Enter would commit.
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  const selected = options.find((o) => o.value === value);

  // Next selectable index from `from` in `dir` — clamps (no wrap) and skips
  // disabled rows so keyboard nav never lands on an unpickable option.
  const stepActive = (from: number, dir: 1 | -1): number => {
    let i = from;
    for (let n = 0; n < filtered.length; n++) {
      i += dir;
      if (i < 0 || i >= filtered.length) return from;
      if (!filtered[i]?.disabled) return i;
    }
    return from;
  };
  const firstEnabled = (): number => {
    const i = filtered.findIndex((o) => !o.disabled);
    return i === -1 ? 0 : i;
  };

  // Close on outside click; focus the search input (searchable) or the list
  // itself so ↑/↓/Enter/Esc reach the panel handler even without a search box.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    if (searchable) searchRef.current?.focus();
    else listRef.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, searchable]);

  // Keep the active option scrolled into view while arrowing through the list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openPanel = () => {
    if (disabled) return;
    setQuery('');
    const sel = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(sel === -1 ? firstEnabled() : sel);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // stopPropagation, not just preventDefault: this panel can be open INSIDE a
      // modal, and `Modal` (plus the invite dialog in team-members-panel) listens
      // for Escape on `window` in the bubble phase. Without this, one Escape
      // closes the listbox AND the dialog behind it, discarding whatever the host
      // had typed — a regression against the native <select>, whose OS popup
      // swallowed the key. `ConfirmDialog` guards the same way.
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => stepActive(a, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => stepActive(a, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) pick(opt);
    }
  };

  // Close when focus leaves the component entirely. The outside-click listener
  // above only catches the mouse; a keyboard user who Tabs off an open panel
  // would otherwise leave it hanging over the page (APG expects a listbox to
  // close on focus loss). `relatedTarget` is null when focus goes nowhere at all,
  // which `contains` reads as outside — the behaviour we want.
  const onBlurCapture = (e: React.FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative" onBlur={onBlurCapture}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={title}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm transition-colors hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : (placeholder ?? '')}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          onKeyDown={onKeyDown}
        >
          {searchable ? (
            // `role="combobox"` + `aria-expanded` are what make the two
            // relationship attributes below live: on a bare <input> they are
            // inert, and the filter box would own focus while announcing nothing
            // about the list it drives. `min-h-[44px]` because this is the third
            // interactive control in the panel and the mobile bar applies to it
            // as much as to the trigger and the rows — latent today (`searchable`
            // defaults false) and therefore exactly what ships unnoticed.
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
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? optionId(active) : undefined}
              className="min-h-[44px] border-b border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none"
            />
          ) : null}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={filtered[active] ? optionId(active) : undefined}
            tabIndex={-1}
            className="max-h-64 overflow-y-auto p-1 focus:outline-none"
          >
            {filtered.map((o, i) => {
              const isSelected = o.value === value;
              return (
                <li
                  key={`${o.value}-${i}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled || undefined}
                  data-index={i}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={o.disabled}
                    // Keep focus on the list while the row is clicked. Safari and
                    // Firefox do not focus a <button> on mousedown, so without
                    // this the close-on-focus-loss handler above would fire on
                    // mousedown and unmount the panel before mouseup delivered
                    // the click — the option would never be picked.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                    onMouseEnter={() => {
                      if (!o.disabled) setActive(i);
                    }}
                    className={cn(
                      'flex min-h-[44px] w-full items-center gap-3 rounded-sm px-2 py-2.5 text-left text-sm',
                      o.disabled
                        ? 'cursor-not-allowed opacity-40'
                        : isSelected
                          ? 'bg-primary text-primary-foreground'
                          : // The keyboard cursor — the row Enter commits. A bare
                            // `bg-muted` wash is 1.14:1 on dark and 1.17:1 on light
                            // against the popover, so the one thing telling you what
                            // you are about to choose was the least visible thing in
                            // the list. Same accent rim `globals.css` puts on every
                            // un-prefixed accent fill.
                            i === active
                            ? 'bg-muted shadow-[inset_0_0_0_1px_var(--primary-edge)]'
                            : 'hover:bg-muted',
                    )}
                  >
                    <span className="truncate">{o.label}</span>
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
