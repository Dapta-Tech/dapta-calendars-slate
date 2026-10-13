/**
 * Whether the browser suite's seed may write to a database. The seed connects
 * hosts to a stand-in calendar, which would be wrong anywhere real, and the
 * NODE_ENV guard it used to rely on cannot see that: `apps/web/e2e/start-api.mjs`
 * always runs it under NODE_ENV=development.
 *
 * Allowed: a SQLite file (local by nature), a Postgres database whose name ends
 * in `_e2e`, or a Postgres server on loopback. Refused: anything else, and
 * anything that does not parse.
 */
export function e2eDatabaseAllowed(databaseUrl: string): { ok: true } | { ok: false; reason: string } {
  const url = databaseUrl.trim();
  if (!url) return { ok: false, reason: 'DATABASE_URL is empty' };
  if (url.startsWith('file:')) return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'DATABASE_URL does not parse' };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { ok: false, reason: `unexpected scheme ${parsed.protocol}` };
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '::1';
  if (name.endsWith('_e2e') || loopback) return { ok: true };
  return {
    ok: false,
    reason: `database "${name}" on ${host || '(no host)'} is neither named *_e2e nor on loopback`,
  };
}
