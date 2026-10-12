#!/usr/bin/env node
// The public rate limiter, from one client: ramp past the limit and prove the
// 429 arrives with Retry-After, then prove that a spoofed X-Forwarded-For
// (a fresh made-up address in front of the real one, every request) does not
// buy a fresh bucket.
//
//   node scripts/qa/rate-limit-probe.mjs --api https://api.example.test \
//     --page <accountCode>/<handle> [--max 120] [--pause 70]
//
// Reads the public profile route only (no calendar read, no write). Stops at
// the first 5xx. --pause waits for the bucket to refill between the two parts.
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.api || !args.page) {
  console.error('usage: --api <base url> --page <accountCode>/<handle> [--max 120]');
  process.exit(2);
}
const [accountCode, handle] = args.page.split('/');
const url = `${args.api.replace(/\/$/, '')}/v1/profiles/${encodeURIComponent(accountCode)}/${encodeURIComponent(handle)}`;
const max = Number(args.max ?? 120);
const pauseS = Number(args.pause ?? 70);

async function ramp(label, headersFor) {
  const started = Date.now();
  for (let i = 1; i <= max; i++) {
    const r = await fetch(url, { headers: { 'user-agent': 'calendars-qa-limiter/1.0', ...headersFor(i) } });
    await r.arrayBuffer();
    if (r.status >= 500) {
      console.log(`[${label}] stopped: ${r.status} at request ${i}`);
      return { firstLimited: null, stopped: true };
    }
    if (r.status === 429) {
      const retryAfter = r.headers.get('retry-after');
      console.log(
        `[${label}] 429 at request ${i} after ${((Date.now() - started) / 1000).toFixed(1)}s, Retry-After: ${retryAfter ?? '(missing)'}`,
      );
      return { firstLimited: i, retryAfter };
    }
  }
  console.log(`[${label}] no 429 in ${max} requests`);
  return { firstLimited: null };
}

const plain = await ramp('one client', () => ({}));
let failed = !plain.firstLimited || !plain.retryAfter;
if (!plain.stopped) {
  await new Promise((r) => setTimeout(r, pauseS * 1000));
  const spoofed = await ramp('spoofed X-Forwarded-For', (i) => ({
    'x-forwarded-for': `203.0.113.${(i % 250) + 1}`,
  }));
  if (!spoofed.firstLimited) failed = true;
  else if (plain.firstLimited && spoofed.firstLimited > plain.firstLimited + 5) {
    console.log('[spoofed X-Forwarded-For] FAIL: the spoofed header bought a larger bucket');
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
