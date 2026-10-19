import { headers } from 'next/headers';
import { PATH_HEADER } from '@/lib/theme';

/**
 * One segment of THIS request's own path (decoded), from the path the
 * middleware forwards as `PATH_HEADER`; `null` when the path is shorter or the
 * header is missing.
 *
 * A layout is handed its own params and never its children's, which is what a
 * host or team layout needs to ask "and does the event below me exist?" on a
 * full load (see `app/[accountCode]/[handle]/layout.tsx`). A segment that does
 * not decode comes back as written, so it simply matches nothing.
 */
export async function requestPathSegment(index: number): Promise<string | null> {
  const path = (await headers()).get(PATH_HEADER);
  if (path === null) return null;
  const segment = path.split('/').filter(Boolean)[index];
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
