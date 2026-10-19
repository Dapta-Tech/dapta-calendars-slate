'use server';

import { redirect, unstable_rethrow } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';

/**
 * The person's answer on the consent page. The API checks who is deciding (the
 * session this call carries) and answers with where the browser goes next:
 * back to the authorization server, carrying a single-use ticket, where the
 * cookie set when the app started the request must match. A redirect there is
 * the only success; anything else leaves the person on this page with the
 * error copy.
 *
 * A Server Action, not a route handler, so Next's own Origin check guards it
 * against cross-site posts.
 */
export async function decideConsentAction(
  _prev: { error?: boolean } | null,
  form: FormData,
): Promise<{ error?: boolean }> {
  const uid = String(form.get('uid') ?? '');
  const decision = form.get('decision') === 'approve' ? 'approve' : 'deny';
  let redirectTo: string;
  try {
    ({ redirectTo } = await adminApi.oauthDecide(uid, decision));
  } catch (e) {
    unstable_rethrow(e); // a 401 sends the person through the login and back here
    return { error: true };
  }
  redirect(redirectTo);
}
