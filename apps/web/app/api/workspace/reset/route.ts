import { NextResponse, type NextRequest } from 'next/server';
import { requestOrigin } from '@/lib/request-origin';
import { RETURN_TO_PARAM, safeReturnTo } from '@/lib/return-to';
import { chosenWorkspace, clearWorkspace } from '@/lib/workspace';

/**
 * Where a render lands when the API refused the chosen workspace (the
 * membership was removed or disabled, or the invitation is not accepted). A
 * render cannot write cookies, so it redirects here with the refused id (`w`)
 * and the page it was on (`next`).
 *
 * The cookie is cleared only while it still names the refused workspace: a
 * newer choice made in another tab survives, and a link from another site
 * (which cannot know the id) changes nothing. Then back to the page, now in the
 * person's own account.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const refused = params.get('w');
  if (refused && refused === (await chosenWorkspace())) await clearWorkspace();
  const back = safeReturnTo(params.get(RETURN_TO_PARAM)) ?? '/admin';
  return NextResponse.redirect(new URL(back, requestOrigin(req)));
}
