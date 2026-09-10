'use server';

import { createBookingSchema } from '@slate/types';
import {
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
export async function reserveAction(input: {
  accountCode: string;
  handle: string;
  slug: string;
  startUtc: string;
}): Promise<ReserveResult> {
  return postReservation(input);
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
  const attendee = {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    timeZone: String(formData.get('timeZone') ?? 'UTC'),
    notes: formData.get('notes') ? String(formData.get('notes')) : undefined,
  };

  if (kind === 'team') {
    return postTeamBooking(accountCode, ownerSlug, { slug, startUtc, attendee, answers: answersObj });
  }

  const parsed = createBookingSchema.safeParse({
    accountCode,
    handle: ownerSlug,
    slug,
    startUtc,
    attendee,
    answers: answersObj,
  });
  if (!parsed.success) {
    return { ok: false, status: 400, error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message };
  }
  return postBooking(parsed.data);
}
