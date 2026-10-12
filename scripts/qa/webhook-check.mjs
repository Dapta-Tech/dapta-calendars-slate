#!/usr/bin/env node
// Webhook deliveries that misbehave: a subscriber that answers after 15 s and
// one that answers with a redirect. The deliveries must time out and refuse to
// follow, and the outbox must retry them as designed (backoff, then failed).
//
// Two local receivers listen on --port (default 4520):
//   /slow       sleeps 15 s, then 200
//   /redirect   302 to a loopback address (must never be fetched)
//   /internal   the redirect target; any hit on it is a failure
//
// The API refuses non-https and private addresses for subscribers, so the
// receivers are reached through a public https tunnel to --port; pass its URL
// as --public. Webhooks are created through the host API of --api, which must
// be a LOCAL instance on the local auth provider (x-slate-email), never a
// shared deployment.
//
//   cloudflared tunnel --url http://127.0.0.1:4520     # prints https://<x>.trycloudflare.com
//   node scripts/qa/webhook-check.mjs --api http://localhost:4411 \
//     --public https://<x>.trycloudflare.com --host-email alex@example.com \
//     --page acme/alex-rivera/intro-call [--watch 90]
import { createServer } from 'node:http';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ['api', 'public', 'host-email', 'page'])
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
const api = args.api.replace(/\/$/, '');
const pub = args.public.replace(/\/$/, '');
const port = Number(args.port ?? 4520);
const watchS = Number(args.watch ?? 90);
const [accountCode, handle, slug] = args.page.split('/');
const asHost = { 'content-type': 'application/json', 'x-slate-email': args['host-email'] };

const hits = { slow: [], redirect: [], internal: [] };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://receiver').pathname.replace(/^\//, '');
  req.resume();
  if (path in hits) hits[path].push(Date.now());
  if (path === 'slow') return setTimeout(() => res.writeHead(200).end('ok'), 15_000);
  if (path === 'redirect') return res.writeHead(302, { location: 'http://127.0.0.1/internal' }).end();
  res.writeHead(200).end('ok');
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const created = [];
async function webhook(path) {
  const r = await fetch(`${api}/v1/webhooks`, {
    method: 'POST',
    headers: asHost,
    body: JSON.stringify({ subscriberUrl: `${pub}/${path}`, eventTriggers: ['booking.created'] }),
  });
  if (!r.ok) throw new Error(`create webhook ${path} -> ${r.status} ${await r.text()}`);
  const body = await r.json();
  created.push(body.id ?? body.webhook?.id);
}

let failed = false;
try {
  await webhook('slow');
  await webhook('redirect');
  // One booking, so each subscriber gets one booking.created delivery.
  const from = Date.now() + 5 * 86_400_000;
  const qs = new URLSearchParams({ accountCode, handle, slug, from: new Date(from).toISOString(), to: new Date(from + 7 * 86_400_000).toISOString() });
  const a = await (await fetch(`${api}/v1/availability?${qs}`)).json();
  const startUtc = a.slots[0]?.startUtc;
  if (!startUtc) throw new Error('no offered time to book');
  const b = await fetch(`${api}/v1/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountCode,
      handle,
      slug,
      startUtc,
      attendee: { name: 'Webhook Check', email: `webhook-check-${Date.now()}@example.test`, timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    }),
  });
  if (b.status !== 201) throw new Error(`booking -> ${b.status} ${await b.text()}`);
  console.log(`booked ${startUtc}; watching deliveries for ${watchS}s`);
  await new Promise((r) => setTimeout(r, watchS * 1000));

  const gaps = (xs) => xs.slice(1).map((t, i) => Math.round((t - xs[i]) / 1000));
  console.log(`/slow      hits ${hits.slow.length}, seconds between attempts ${JSON.stringify(gaps(hits.slow))}`);
  console.log(`/redirect  hits ${hits.redirect.length}, seconds between attempts ${JSON.stringify(gaps(hits.redirect))}`);
  console.log(`/internal  hits ${hits.internal.length} (must be 0: a redirect is never followed)`);
  if (hits.internal.length) failed = true;
  if (hits.slow.length < 2) {
    console.log('FAIL: the slow subscriber was not retried');
    failed = true;
  }
  if (hits.redirect.length < 2) {
    console.log('FAIL: the redirecting subscriber was not retried');
    failed = true;
  }
} finally {
  for (const id of created.filter(Boolean)) await fetch(`${api}/v1/webhooks/${id}`, { method: 'DELETE', headers: asHost });
  server.close();
}
process.exit(failed ? 1 : 0);
