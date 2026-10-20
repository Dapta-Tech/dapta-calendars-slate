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

/** How long either upstream call may take before the download gives up. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * The most of the OpenAPI document this route will read. The real one is about
 * a tenth of this; anything far larger is not the document it expects, and
 * reading it whole would hold a server worker on someone else's mistake.
 */
const MAX_OPENAPI_BYTES = 2 * 1024 * 1024;

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
 * Every failure is JSON with a stable `error` code, which is what the guide's
 * download button reads to tell the person what went wrong: 401 signed out,
 * 403 a member, 503 no public API address or the API busy, 502 the API (or
 * the identity service) did not answer usefully.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return unauthenticated();

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
  if (me?.status === 401) return unauthenticated();
  if (me?.status === 403) return forbidden();
  if (me?.status === 429) return busy(me);
  if (!me?.ok) return failure(502, 'UPSTREAM_UNAVAILABLE', 'Could not confirm your session. Try again.');
  const role = ((await me.json().catch(() => null)) as { role?: unknown } | null)?.role;
  if (typeof role !== 'string' || !isAdminRole(role as AccountRole)) return forbidden();

  // The MCP address hangs off the API origin unless it is set on its own, so
  // with an origin there is always one; both are checked for the type's sake.
  const { apiOrigin, mcpUrl } = resolveMcpConfig();
  if (!apiOrigin || !mcpUrl) {
    return failure(503, 'API_URL_NOT_CONFIGURED', 'This installation has no public API address configured.');
  }

  const described = await apiDescription();
  if (described instanceof Response) return busy(described);
  if (described === 'too-large') {
    return failure(502, 'OPENAPI_TOO_LARGE', 'The API description is larger than expected.');
  }
  if (!described) return failure(502, 'OPENAPI_UNAVAILABLE', 'Could not read the API description. Try again.');

  const zip = createZip(
    buildSkillFiles({
      apiUrl: apiOrigin,
      mcpUrl,
      appUrl: dashboardUrl(request),
      productName: PRODUCT_NAME,
      openapi: described,
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

/** The API's answer to "who is this session?", or null when it cannot be reached in time. */
async function whoAmI(): Promise<Response | null> {
  return fetch(`${serverApiUrl()}/v1/me`, {
    headers: await hostHeaders(),
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);
}

/**
 * The OpenAPI document the API serves; its 429 as is, so the caller can pass
 * the wait on; `too-large` past the cap; null when it is unreachable, slow or
 * not a document.
 */
async function apiDescription(): Promise<OpenApiDocument | Response | 'too-large' | null> {
  const res = await fetch(`${serverApiUrl()}/openapi.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);
  if (res?.status === 429) return res;
  if (!res?.ok) return null;
  const text = await readCapped(res, MAX_OPENAPI_BYTES).catch(() => null);
  if (text === 'too-large') return text;
  if (text === null) return null;
  try {
    return parseOpenApi(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The body as text, or `too-large` as soon as it passes `max` bytes (declared or read). */
async function readCapped(res: Response, max: number): Promise<string | 'too-large'> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    return 'too-large';
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function unauthenticated(): NextResponse {
  return failure(401, 'UNAUTHENTICATED', 'Sign in to download the skill.');
}

function forbidden(): NextResponse {
  return failure(403, 'FORBIDDEN', 'Only owners and admins can download the skill.');
}

/** The API is shedding load: say so, and pass its wait on when it gave one. */
function busy(upstream: Response): NextResponse {
  const res = failure(503, 'UPSTREAM_BUSY', 'The service is busy. Try again in a moment.');
  const wait = upstream.headers.get('retry-after');
  if (wait) res.headers.set('retry-after', wait);
  return res;
}

function failure(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status, headers: { 'cache-control': 'no-store' } });
}
