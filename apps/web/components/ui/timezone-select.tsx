'use client';

import { useMemo } from 'react';
import { commonTimeZones, getMessages } from '@slate/shared';
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
 * option list and its GMT-offset hints. Everything else is `Select`'s. The
 * public contract is unchanged (`value` / `onChange` / `locale` / `id` /
 * `ariaLabel` / `className`) and the rendering matches what it rendered before
 * — zone on the left, offset on the right, on the trigger and on every row —
 * so the admin's two timezone fields are untouched by this.
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
  // Offsets are computed once per zone list (they only shift on DST
  // boundaries), and the label carries spaces so typing "new york" matches —
  // `Select` also matches on `value`, which keeps the underscored form
  // searchable.
  const options = useMemo<SelectOption[]>(
    () =>
      commonTimeZones(value).map((z) => ({
        value: z,
        label: z.replaceAll('_', ' '),
        hint: zoneOffset(z),
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
      locale={locale}
      searchPlaceholder={m.search}
      noResultsText={m.noResults}
    />
  );
}
