import { NextResponse, type NextRequest } from 'next/server';
import { requestOrigin } from '@/lib/request-origin';
import { adminJoinPath } from '@/lib/workspace-paths';

/**
 * The link in the invitation email (`/invite/{account code}`), kept short and
 * readable. Joining needs a session, and only dashboard pages may be a sign-in's
 * return target, so it hands over to `/admin/join/{code}`, which does the work.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ accountCode: string }> }): Promise<NextResponse> {
  const { accountCode } = await params;
  return NextResponse.redirect(new URL(adminJoinPath(accountCode), requestOrigin(req)));
}
