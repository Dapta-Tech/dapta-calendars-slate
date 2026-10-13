// What every QA script that sends traffic checks before its first request.
//
//  - `--api` must NAME loopback literally (localhost, 127.0.0.0/8, ::1), unless
//    the caller passes `--i-know-this-is-not-prod`, which allows a non-loopback
//    development deployment. No DNS lookup decides it: `fetch` resolves the
//    name again, so a rebinding host could answer 127.0.0.1 to the check and a
//    remote address to the request. Any other name is not loopback.
//  - `--deny-hosts a,b` is a comma-separated list of hosts the script must
//    never touch (a production API, for one). A denied host, or any subdomain
//    of it, is refused even with the flag above. The list is an argument on
//    purpose: no host is written in this tree.
//
// Scripts that must never leave the machine (webhook-check) call
// `requireLoopback` instead, which has no override.
import { isIP } from 'node:net';

export const NOT_PROD_FLAG = 'i-know-this-is-not-prod';

/**
 * `--key value` pairs, and `--flag` alone (followed by another `--` or nothing)
 * as `true`, so a boolean flag never swallows the next option.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function isLoopbackAddress(address) {
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) === 6) return address === '::1' || address.startsWith('::ffff:127.');
  return false;
}

/** True only when the API's host is literally loopback: `localhost`, 127.x or ::1. Never a lookup. */
export function isLoopbackTarget(api) {
  let host;
  try {
    host = new URL(api).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || isLoopbackAddress(host);
}

function denied(api, denyHosts) {
  const host = new URL(api).hostname.toLowerCase();
  const list = typeof denyHosts === 'string' ? denyHosts.split(',') : [];
  return list
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .find((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Refuse a target the caller did not mean: anything on the denylist, and
 * anything that is not loopback without `--i-know-this-is-not-prod`. Exits 2
 * with the reason; returns quietly when the target is allowed.
 */
export async function guardTarget(args) {
  const api = String(args.api);
  const hit = denied(api, args['deny-hosts']);
  if (hit) {
    console.error(`refusing --api ${api}: it is on --deny-hosts (${hit})`);
    process.exit(2);
  }
  if (isLoopbackTarget(api)) return;
  if (args[NOT_PROD_FLAG] === true) {
    console.error(`--api ${api} is not loopback; going ahead because --${NOT_PROD_FLAG} was passed`);
    return;
  }
  console.error(
    `refusing --api ${api}: it is not loopback. Pass --${NOT_PROD_FLAG} for a development deployment, ` +
      'and --deny-hosts <host,...> to rule out the ones that must never be hit.',
  );
  process.exit(2);
}

/** For scripts that must only ever talk to an API on this machine. No override. */
export async function requireLoopback(api, what = '--api') {
  if (isLoopbackTarget(api)) return;
  console.error(`refusing ${what} ${api}: this script only runs against a local API (loopback)`);
  process.exit(2);
}
