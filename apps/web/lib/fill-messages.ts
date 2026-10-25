import { t } from '@slate/shared';

/**
 * A catalog section with some of its placeholders filled in, in every string
 * at any depth. A placeholder not named in `vars` stays as it is (`t` leaves
 * an unknown `{name}` alone), so a client component can still fill `{app}` or
 * `{url}` later.
 */
export function fillMessages<T>(section: T, vars: Record<string, string | number>): T {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return t(value, vars);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    }
    return value;
  };
  return fill(section) as T;
}
