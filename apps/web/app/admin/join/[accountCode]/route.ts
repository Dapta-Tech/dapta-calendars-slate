import { NextResponse, type NextRequest } from 'next/server';
import type { WorkspaceView } from '@slate/types';
import { getSession, hostFetch } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';
import { withReturnTo } from '@/lib/return-to';
import { clearWorkspace, setWorkspace } from '@/lib/workspace';
import { accountCodeFrom, adminJoinPath, notForYouPath } from '@/lib/workspace-paths';

/**
 * Joining a workspace from the invitation email.
 *
 * Signed out: through the login and back here (a dashboard path, so it may be
 * the sign-in's return target). Signed in: the person's workspaces are read
 * from the API as THEM (no workspace header, whatever workspace they were in),
 * and when one has this code the dashboard opens in it. Opening it is what
 * accepts the invitation: the API turns the member active on the first call
 * made in that workspace. No invitation for this person: a page that says so,
 * the same for an unknown code as for someone else's invitation, so the link
 * never tells a stranger which workspaces exist.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ accountCode: string }> }): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const code = accountCodeFrom((await params).accountCode);
  if (!code) return NextResponse.redirect(new URL('/admin', origin));
  if (!(await getSession())) {
    return NextResponse.redirect(new URL(withReturnTo('/login', adminJoinPath(code)), origin));
  }

  const res = await hostFetch('/v1/me/workspaces', undefined, { workspace: false });
  if (!res.ok) return NextResponse.redirect(new URL('/admin', origin));
  const workspaces = (await res.json()) as WorkspaceView[];
  const match = workspaces.find((w) => w.accountCode.toLowerCase() === code);
  if (!match) return NextResponse.redirect(new URL(notForYouPath(code), origin));

  if (match.home) await clearWorkspace();
  else await setWorkspace(match.accountId);
  return NextResponse.redirect(new URL('/admin', origin));
}
