'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** A count shown beside the label (errors in that tab); 0 or absent hides it. */
  badge?: number;
  /** What the badge means, for assistive technology ("2 fields need attention"). */
  badgeLabel?: string;
}

const tabDomId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
const panelDomId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * An underlined tab strip (WAI-ARIA tabs, automatic activation): arrow keys,
 * Home and End move to a tab and select it, and only the selected tab is in
 * the Tab order. Pair each tab with a `TabPanel` of the same `idPrefix` + id.
 * The strip scrolls sideways at narrow widths instead of wrapping.
 */
export function Tabs<T extends string>({
  items,
  active,
  onChange,
  idPrefix,
  label,
  className,
}: {
  items: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  idPrefix: string;
  /** The tab list's accessible name. */
  label: string;
  className?: string;
}) {
  const refs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = items.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (at + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    const picked = items[next]!.id;
    onChange(picked);
    refs.current[picked]?.focus();
  };

  return (
    <div
      className={cn(
        'overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex w-max min-w-full gap-group">
        {items.map((t) => {
          const selected = t.id === active;
          const badge = t.badge ?? 0;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={tabDomId(idPrefix, t.id)}
              aria-selected={selected}
              aria-controls={panelDomId(idPrefix, t.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn(
                '-mb-px flex min-h-control shrink-0 items-center gap-inline border-b-2 px-tight text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-signal-edge text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {badge > 0 ? (
                <>
                  <span
                    aria-hidden
                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-destructive/15 px-tight text-xs font-semibold text-destructive"
                  >
                    {badge}
                  </span>
                  {t.badgeLabel ? <span className="sr-only">, {t.badgeLabel}</span> : null}
                </>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One tab's content. Stays MOUNTED while hidden, so its fields keep their
 * values and can be found and focused by id (a save that jumps to an error in
 * another tab needs the field to exist).
 */
export function TabPanel({
  id,
  idPrefix,
  active,
  children,
  className,
}: {
  id: string;
  idPrefix: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={panelDomId(idPrefix, id)}
      aria-labelledby={tabDomId(idPrefix, id)}
      hidden={!active}
      className={className}
    >
      {children}
    </div>
  );
}
