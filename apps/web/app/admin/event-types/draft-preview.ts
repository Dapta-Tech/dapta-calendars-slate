/**
 * The eye button's hand-off: the editor's unsaved draft goes to a new tab that
 * draws it as the booking page. It travels through localStorage (same origin,
 * one key per click, removed once read), never the URL, so nothing the host
 * typed ends up in history or a server log.
 */
import type { BookingField } from '@slate/types';

export interface DraftPreview {
  title: string;
  description: string | null;
  lengthMinutes: number;
  location: { kind: string; detail?: string | null } | null;
  bookingFields: BookingField[];
}

const PREFIX = 'dcal:event-preview:';

export function openDraftPreview(draft: DraftPreview, teamId?: string | null): void {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(draft));
  } catch {
    /* storage blocked: the tab opens and says there is nothing to preview */
  }
  const params = new URLSearchParams({ k: key, ...(teamId ? { team: teamId } : {}) });
  window.open(`/preview/event?${params}`, '_blank', 'noopener');
}

/** Read (and forget) the draft a preview tab was opened with; null when there is none. */
export function takeDraftPreview(key: string | null): DraftPreview | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    // Kept for a reload of this tab, until the next preview replaces it.
    for (const k of Object.keys(window.localStorage)) {
      if (k.startsWith(PREFIX) && k !== PREFIX + key) window.localStorage.removeItem(k);
    }
    return JSON.parse(raw) as DraftPreview;
  } catch {
    return null;
  }
}
