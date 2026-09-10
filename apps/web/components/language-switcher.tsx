'use client';

import { useTransition } from 'react';
import type { Locale } from '@slate/shared';
import { Select } from '@/components/ui/select';
import { setLocaleAction } from '@/app/admin/locale-actions';

/** F8 language toggle — persists the choice via a cookie (server action) and
 *  re-renders the admin in EN/ES. Mirrors the old app's language selector.
 *
 *  A2 (#112): this was the last native `<select>` on the settings cluster, and
 *  the most conspicuous one — the control that switches the app's language was
 *  itself drawn by the operating system, in the OS palette, at the OS row
 *  height, on a themed page. The option labels are deliberately NOT translated:
 *  a language picker names each language in that language, so someone who
 *  cannot read the current one can still find their own. */
export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  const [pending, start] = useTransition();
  return (
    // A <div>, not a <label>: the Select's trigger is a <button>, which is not a
    // labelable element. The name rides on `ariaLabel`.
    <div className="flex max-w-xs flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={locale}
        options={[
          { value: 'en', label: 'English' },
          { value: 'es', label: 'Español' },
        ]}
        disabled={pending}
        ariaLabel={label}
        locale={locale}
        onChange={(next) =>
          start(() => {
            void setLocaleAction(next);
          })
        }
      />
    </div>
  );
}
