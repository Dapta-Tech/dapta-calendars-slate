import { unstable_rethrow } from 'next/navigation';
import { LIKELY_BODY_LIMIT_BYTES } from '@slate/types';

/**
 * What to tell the host when a Server Action's REQUEST was refused, rather than
 * the action running and returning a failure.
 *
 * It lives here, apart from the component, for one reason: the first line is
 * load-bearing and is otherwise untestable. A thrown redirect is how the
 * session layer sends an expired host to the login or refresh route, and Next
 * delivers it by REJECTING the action promise — so a bare `catch` around an
 * action swallows it and strands a signed-out host on the page. `unstable_rethrow`
 * puts those back; everything else is ours to report.
 *
 * The size test is deliberately against the smallest ceiling likely to be in
 * the path, not against ours. A reverse proxy refusing at its own 1MB default
 * is still a too-large failure, and telling that host "Save failed" would send
 * them looking in the wrong place.
 */
export function saveErrorMessage(
  error: unknown,
  payload: unknown,
  copy: { tooLarge: string; failed: string },
): string {
  unstable_rethrow(error);
  const size = new Blob([JSON.stringify(payload)]).size;
  return size > LIKELY_BODY_LIMIT_BYTES ? copy.tooLarge : copy.failed;
}
