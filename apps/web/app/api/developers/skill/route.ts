import { NextResponse, type NextRequest } from 'next/server';
import { isAdminRole, type AccountRole } from '@/lib/admin-api';
import { getSession, hostHeaders, refreshUpstreamSession, setSession } from '@/lib/auth-session';
import { dashboardUrl } from '@/lib/developer-skill/dashboard-url';
import { parseOpenApi, type OpenApiDocument } from '@/lib/developer-skill/openapi-doc';
import { buildSkillFiles, SKILL_ZIP_NAME } from '@/lib/developer-skill/skill-files';
import { createZip } from '@/lib/developer-skill/zip';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { PRODUCT_NAME } from '@/lib/product-name';

// SERVER-side API base, read per request like `admin-api.ts` reads it: the
// runtime `API_URL` first, which may be an address only the cluster resolves.
// The skill never prints it; it prints the public origin from `mcp-config.ts`.
const serverApiUrl = (): string => process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The API skill as a zip, built for the installation it is downloaded from:
 * the API, MCP and dashboard addresses come from the runtime environment, and
 * the endpoint reference from the API's own OpenAPI document, fetched here.
 *
 * Owners and admins only, the people who can open the keys page and make the
 * key the skill needs. A cookie alone is not enough: the API must still accept
 * the session, so a revoked or expired one answers 401 rather than a zip. The
 * archive holds no secret (the key is never in it), but the keys page is the
 * only door to it and that door is admin-only.
 *
 * Answers are JSON for every failure, so a broken download says why: 401
 * signed out, 403 a member, 502 the API (or the identity service) did not
 * answer, 503 no public API address to write into the skill.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return failure(401, 'UNAUTHENTICATED', 'Sign in to download the skill.');

  let me = await whoAmI();
  if (me?.status === 401) {
    // An expired access token is not a signed-out admin: trade the refresh
    // token once, as `hostFetch` does, and ask again. Without this a click on
    // the download long after the page loaded would answer 401 to someone the
    // dashboard still shows as signed in.
    const refreshed = await refreshUpstreamSession(session);
    if (refreshed.outcome === 'refreshed') {
      await setSession(refreshed.session);
      me = await whoAmI();
    } else if (refreshed.outcome === 'unavailable') {
      // Nothing was learned about the session (#114): not a sign-out.
      return failure(502, 'UPSTREAM_UNAVAILABLE', 'Could not confirm your session. Try again.');
    }
  }
  if (me?.status === 401) return failure(401, 'UNAUTHENTICATED', 'Sign in to download the skill.');
  if (me?.status === 403) return forbidden();
  if (!me?.ok) return failure(502, 'UPSTREAM_UNAVAILABLE', 'Could not confirm your session. Try again.');
  const role = ((await me.json().catch(() => null)) as { role?: unknown } | null)?.role;
  if (typeof role !== 'string' || !isAdminRole(role as AccountRole)) return forbidden();

  const { apiOrigin, mcpUrl } = resolveMcpConfig();
  if (!apiOrigin) {
    return failure(503, 'API_URL_NOT_CONFIGURED', 'This installation has no public API address configured.');
  }

  const openapi = await apiDescription();
  if (!openapi) return failure(502, 'OPENAPI_UNAVAILABLE', 'Could not read the API description. Try again.');

  const zip = createZip(
    buildSkillFiles({
      apiUrl: apiOrigin,
      mcpUrl,
      appUrl: dashboardUrl(request),
      productName: PRODUCT_NAME,
      openapi,
    }),
  );
  return new NextResponse(zip, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${SKILL_ZIP_NAME}"`,
      'content-length': String(zip.byteLength),
      'cache-control': 'no-store',
    },
  });
}

/** The API's answer to "who is this session?", or null when it cannot be reached. */
async function whoAmI(): Promise<Response | null> {
  return fetch(`${serverApiUrl()}/v1/me`, { headers: await hostHeaders(), cache: 'no-store' }).catch(() => null);
}

/** The OpenAPI document the API serves, or null when it is unreachable or not one. */
async function apiDescription(): Promise<OpenApiDocument | null> {
  const res = await fetch(`${serverApiUrl()}/openapi.json`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  return parseOpenApi(await res.json().catch(() => null));
}

function forbidden(): NextResponse {
  return failure(403, 'FORBIDDEN', 'Only owners and admins can download the skill.');
}

function failure(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: { 'cache-control': 'no-store' } });
}
