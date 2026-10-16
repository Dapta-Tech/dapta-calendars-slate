'use server';

import { createBookingSchema } from '@slate/types';
import {
  getManageView,
  postBooking,
  postTeamBooking,
  postReservation,
  postReservationRelease,
  type BookResult,
  type ReserveResult,
} from '@/lib/api';

/**
 * Server Action: hold a slot. MUST stay a server action (not a direct client
 * call) — the API base comes from `NEXT_PUBLIC_API_URL`, which Next inlines into
 * the CLIENT bundle at BUILD time, so a client-side call would hit whatever URL
 * was baked (one image serves all envs) instead of this deployment's API. Server
 * actions read it at RUNTIME from the per-env configmap → always the right env.
 */
export async function reserveAction(
  input: {
    accountCode: string;
    handle: string;
    slug: string;
    startUtc: string;
  },
  /**
   * A one-off link token (#110) when this page was opened through
   * `/booking/{token}`. Absent on every ordinary booking page, and absent means
   * nothing changes. Present, it is what lets the hold land on the HIDDEN event
   * the link opens — without it the reserve step 404s and the booker cannot get
   * past the slot picker.
   */
  oneOffToken?: string,
): Promise<ReserveResult> {
  return postReservation(input, oneOffToken);
}

/**
 * Server Action: give a soft hold back when the booker leaves the form (#135).
 * Must be a server action for the same reason `reserveAction` is — the API base
 * is read at RUNTIME here, not baked into the client bundle at build time.
 *
 * Answers nothing. The release is authorised by the uid alone and reports the
 * same success whether or not a hold was there, so there is no result for the
 * caller to act on.
 */
export async function releaseAction(reservationUid: string): Promise<void> {
  await postReservationRelease(reservationUid);
}

/**
 * Server Action: the join link of a booking the visitor has just made, once the
 * calendar write-out has minted it (F5), or null while there is none. Asked
 * with the visitor's own manage credential, through the same token-gated read
 * the manage page uses, and it answers the link alone: nothing else about the
 * booking leaves here. A server action for the reason `reserveAction` is one.
 */
export async function meetingLinkAction(uid: string, token: string): Promise<string | null> {
  if (typeof uid !== 'string' || typeof token !== 'string') return null;
  if (!uid || !token || uid.length > 200 || token.length > 512) return null;
  try {
    const view = await getManageView(uid, token);
    const url = view.ok ? view.booking.meetingUrl : null;
    return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Server Action: re-validate on the server (never trust the client), then POST
 * to the API. Handles both personal and team (round-robin) bookings via `kind`.
 */
export async function bookAction(_prev: BookResult | null, formData: FormData): Promise<BookResult> {
  // Collect dynamic intake answers (fields are named `answer_<name>`).
  const answers: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('answer_')) answers[k.slice('answer_'.length)] = String(v);
  }
  const answersObj = Object.keys(answers).length > 0 ? answers : undefined;

  const accountCode = String(formData.get('accountCode') ?? '');
  const ownerSlug = String(formData.get('ownerSlug') ?? '');
  const slug = String(formData.get('slug') ?? '');
  const startUtc = String(formData.get('startUtc') ?? '');
  const kind = String(formData.get('kind') ?? 'personal');
  // The one-off token (#110) rides the form so the CLIENT island never has to
  // hold an API base URL, and is forwarded to the API as a header rather than
  // in the payload — `createBookingSchema` below would drop it from the body
  // anyway, and a credential belongs on a header. The form field is not a
  // weakening: a token here grants only what a token in the URL already does,
  // and the API re-validates it against the event being booked.
  const oneOffTokenField = formData.get('oneOffToken');
  const oneOffToken = oneOffTokenField ? String(oneOffTokenField) : undefined;
  // The hold the page placed when the visitor picked this time. The booking
  // write consumes it; dropped here (as it was), the hold outlived the booking
  // for its whole ten minutes: a time the visitor then moved off or cancelled
  // stayed hidden from everyone, and every booking counted against the host's
  // cap of ten live holds, so a busy page refused new visitors' holds.
  const reservationField = formData.get('reservationUid');
  const reservationUid = reservationField ? String(reservationField) : undefined;
  // The page's language (F6): the invitee's emails are written in it. Only the
  // two the product speaks; anything else is left out, and the API then keeps
  // the invitee's mail in the host's language, as before.
  const languageField = String(formData.get('language') ?? '');
  const language = languageField === 'es' || languageField === 'en' ? languageField : undefined;
  const attendee = {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    timeZone: String(formData.get('timeZone') ?? 'UTC'),
    notes: formData.get('notes') ? String(formData.get('notes')) : undefined,
    ...(language ? { language } : {}),
  };

  if (kind === 'team') {
    return postTeamBooking(
      accountCode,
      ownerSlug,
      { slug, startUtc, attendee, answers: answersObj },
      oneOffToken,
    );
  }

  const parsed = createBookingSchema.safeParse({
    accountCode,
    handle: ownerSlug,
    slug,
    startUtc,
    attendee,
    answers: answersObj,
    reservationUid,
  });
  if (!parsed.success) {
    return { ok: false, status: 400, error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message };
  }
  return postBooking(parsed.data, oneOffToken);
}
