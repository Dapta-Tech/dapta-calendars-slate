'use client';

import { useMemo } from 'react';
import { commonTimeZones, getMessages, zoneOffsetLabel } from '@slate/shared';
import { Select, type SelectOption } from '@/components/ui/select';

/**
 * TimeZoneSelect — the IANA-zone picker, now a thin adapter over `Select`.
 *
 * It used to be its own listbox: trigger, search filter, ↑/↓/Enter/Esc,
 * click-outside, scroll-into-view and listbox ARIA, all written twice. `Select`
 * (reskin slice P) was generalized FROM this component, so the two were the
 * same widget with two implementations and one of them kept getting the
 * accessibility fixes — the focus-loss close, the visible keyboard cursor, the
 * Escape that does not also close the dialog behind it. This one lost them.
 *
 * What is left here is the only part that was ever about timezones: build the
 * option list and its GMT-offset hints. Everything else is `Select`'s, and the
 * rendering matches what it rendered before — zone on the left, offset on the
 * right, on the trigger and on every row — so the admin's two timezone fields
 * are untouched by this.
 *
 * One prop changed meaning: `className` used to style the ROOT wrapper and now
 * follows `Select`'s convention of styling the TRIGGER, since the panel is
 * positioned off `Select`'s own wrapper. Size this control from its parent
 * container, as `Select` documents — a width passed here would leave the panel
 * wider than the trigger it hangs from. Neither admin call site passes one.
 */

export function TimeZoneSelect({
  value,
  onChange,
  locale = 'en',
  id,
  ariaLabel,
  className,
  panelClassName,
  backdrop,
}: {
  /** IANA zone (e.g. 'America/Mexico_City'). */
  value: string;
  onChange: (tz: string) => void;
  /** 'en' | 'es' — anything getMessages accepts. */
  locale?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
  /** Passed through to `Select`. */
  panelClassName?: string;
  /** Passed through to `Select`: dim the page behind the open list on a phone. */
  backdrop?: boolean;
}) {
  const m = getMessages(locale).tzPicker;
  // Offsets are computed once per zone list (they only shift on DST
  // boundaries), and the label carries spaces so typing "new york" matches —
  // `Select` also matches on `value`, which keeps the underscored form
  // searchable.
  const options = useMemo<SelectOption[]>(
    () =>
      commonTimeZones(value).map((z) => ({
        value: z,
        label: z.replaceAll('_', ' '),
        hint: zoneOffsetLabel(z),
      })),
    [value],
  );

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      searchable
      id={id}
      ariaLabel={ariaLabel}
      className={className}
      panelClassName={panelClassName}
      backdrop={backdrop}
      locale={locale}
      searchPlaceholder={m.search}
      noResultsText={m.noResults}
    />
  );
}
