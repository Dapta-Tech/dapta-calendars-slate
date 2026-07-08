'use server';

import { createBookingSchema } from '@slate/types';
import { postBooking, type BookResult } from '@/lib/api';

/**
 * Server Action: re-validate on the server (never trust the client), then POST
 * to the API. Returns a serializable result the client island renders.
 */
export async function bookAction(_prev: BookResult | null, formData: FormData): Promise<BookResult> {
  // Collect dynamic intake answers (fields are named `answer_<name>`).
  const answers: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('answer_')) answers[k.slice('answer_'.length)] = String(v);
  }

  const raw = {
    accountCode: String(formData.get('accountCode') ?? ''),
    handle: String(formData.get('handle') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    startUtc: String(formData.get('startUtc') ?? ''),
    attendee: {
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      timeZone: String(formData.get('timeZone') ?? 'UTC'),
      notes: formData.get('notes') ? String(formData.get('notes')) : undefined,
    },
    answers: Object.keys(answers).length > 0 ? answers : undefined,
  };

  const parsed = createBookingSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message };
  }
  return postBooking(parsed.data);
}
