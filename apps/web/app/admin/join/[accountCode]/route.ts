import { NextResponse, type NextRequest } from 'next/server';
import type { WorkspaceView } from '@slate/types';
import { getSession, hostFetch } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';
import { withReturnTo } from '@/lib/return-to';
import { clearWorkspace, setWorkspace } from '@/lib/workspace';
import { accountCodeFrom, joinPagePath } from '@/lib/workspace-paths';

/**
 * The link in the invitation email.
 *
 * Signed out: through the login to the invitation page (the sign-in's return
 * target). Signed in: the person's workspaces are read
 * from the API as THEM (no workspace header, whatever workspace they were in).
 * A workspace they already belong to simply opens. Anything else goes to the
 * invitation page, which asks them to Join (the acceptance is that click, a
 * POST, never this GET) or tells them the invitation is not theirs.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ accountCode: string }> }): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const code = accountCodeFrom((await params).accountCode);
  if (!code) return NextResponse.redirect(new URL('/admin', origin));
  if (!(await getSession())) {
    // Back to the invitation PAGE, not to this route: the local login returns
    // through a Server Action redirect, which cannot land on a route handler.
    return NextResponse.redirect(new URL(withReturnTo('/login', joinPagePath(code)), origin));
  }

  const res = await hostFetch('/v1/me/workspaces', undefined, { workspace: false });
  if (!res.ok) return NextResponse.redirect(new URL('/admin', origin));
  const workspaces = (await res.json()) as WorkspaceView[];
  const match = workspaces.find((w) => w.accountCode.toLowerCase() === code);
  if (!match || match.status !== 'active') return NextResponse.redirect(new URL(joinPagePath(code), origin));

  if (match.home) await clearWorkspace();
  else await setWorkspace(match.accountId);
  return NextResponse.redirect(new URL('/admin', origin));
}
