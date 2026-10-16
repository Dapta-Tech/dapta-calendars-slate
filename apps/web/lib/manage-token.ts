/**
 * The manage credential in a manage URL (`/manage/<uid>?token=...`), absolute
 * or relative, or null when there is none. One parser for every caller that
 * holds a manage URL and needs its token: the manage page adopting a rotated
 * token, and the confirmation screen asking for a late join link (F5).
 */
export function manageTokenOf(manageUrl: string | null | undefined): string | null {
  if (!manageUrl) return null;
  try {
    return new URL(manageUrl, 'http://slate.local').searchParams.get('token');
  } catch {
    return null;
  }
}
