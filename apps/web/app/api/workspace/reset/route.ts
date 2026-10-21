import { NextResponse, type NextRequest } from 'next/server';
import { requestOrigin } from '@/lib/request-origin';
import { clearWorkspace } from '@/lib/workspace';

/**
 * Where a dashboard call lands when the API refused the chosen workspace
 * (`WORKSPACE_FORBIDDEN`: the membership was removed or disabled). A render
 * cannot write cookies, so it redirects here: the choice is dropped and the
 * person is back in their own account.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  await clearWorkspace();
  return NextResponse.redirect(new URL('/admin', requestOrigin(req)));
}
