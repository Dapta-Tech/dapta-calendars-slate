import { isSuccessRedirectUrl } from '@slate/types';

/**
 * Redirect after booking: the event type's `successRedirectUrl`, as the booking
 * page follows it.
 *
 * Decisions:
 *   - The booking write is what answers the URL (`successRedirectUrl` on the
 *     public create routes), so only an invitee who booked learns it: no
 *     availability read carries it.
 *   - It fires once a booking lands, accepted or pending, and never on a
 *     reschedule or a cancellation: those live on the manage page, which does
 *     not read it.
 *   - The URL goes as the host saved it. Nothing about the booking or the
 *     invitee is added to it, so no name or email reaches a third-party page
 *     through a query string or its access logs.
 *   - Inside an embed it is the TOP window that moves. Loading a host's thank-you
 *     page inside a frame sized for a calendar would read as broken, and most
 *     sites refuse to be framed at all.
 */

/** The URL to send the invitee to, or null when there is none or it is not one we follow. */
export function redirectTarget(url: string | null | undefined): string | null {
  const value = url?.trim();
  // Checked again here, whatever the read returned: the booking page only ever
  // follows an https address, never `javascript:` or any other scheme.
  return value && isSuccessRedirectUrl(value) ? value : null;
}

/** The destination as the confirmation names it: its host, without `www.`. */
export function redirectSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** The parts of a window a redirect touches; a parameter so a test can hand in its own. */
type RedirectWindow = Pick<Window, 'top' | 'parent' | 'location'>;

/**
 * Send the invitee to `url`. Framed, the top window navigates, which a browser
 * allows a cross-origin frame only shortly after the visitor clicked something
 * (here, Confirm). When it refuses, nothing moves and the confirmation stays,
 * with its Continue link (`target="_top"`) as the way on.
 */
export function followRedirect(url: string, win: RedirectWindow = window): void {
  // The same test as `isFramed`, against the window handed in.
  let framed: boolean;
  try {
    framed = win.parent !== win;
  } catch {
    framed = true;
  }
  if (framed) {
    try {
      win.top!.location.href = url;
    } catch {
      // Refused: the Continue link is the fallback.
    }
    return;
  }
  win.location.assign(url);
}
