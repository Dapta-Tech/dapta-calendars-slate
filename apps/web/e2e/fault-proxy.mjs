#!/usr/bin/env node
// A transparent proxy between the browser suite's web app and its API, which
// can be told to answer the next few matching requests with 429 + Retry-After
// itself. That is how the suite shows what a visitor sees when the API is busy
// (the web calls the API from its own server, so a browser-side stub cannot
// reach those calls). Everything else passes through untouched, both ways.
//
//   node e2e/fault-proxy.mjs          (port E2E_PROXY_PORT, default 4413)
//
// Test-only endpoints, all under /__qa:
//   GET  /__qa/health                 up
//   POST /__qa/throttle {match, times, retryAfter, method?}
//        the next `times` requests whose path contains `match` (and whose
//        method is `method`, when given) get 429 with `Retry-After: retryAfter`
//   POST /__qa/reset                  drop every rule
//   GET  /__qa/served                 how many 429s were answered so far
import { createServer, request as forward } from 'node:http';

const env = (k, d) => process.env[k] || d;
const port = Number(env('E2E_PROXY_PORT', '4413'));
const target = new URL(env('E2E_PROXY_TARGET', `http://localhost:${env('E2E_API_PORT', '4411')}`));

let rules = [];
let served = 0;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const path = req.url ?? '/';
  if (path.startsWith('/__qa/')) {
    if (path === '/__qa/health') return json(res, 200, { ok: true });
    if (path === '/__qa/served') return json(res, 200, { served });
    if (path === '/__qa/reset') {
      rules = [];
      return json(res, 200, { ok: true });
    }
    if (path === '/__qa/throttle') {
      const b = await readBody(req);
      rules.push({
        match: String(b.match ?? ''),
        method: b.method ? String(b.method).toUpperCase() : null,
        times: Number(b.times ?? 1),
        retryAfter: String(b.retryAfter ?? 1),
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  }

  const rule = rules.find(
    (r) => r.times > 0 && path.includes(r.match) && (!r.method || r.method === req.method),
  );
  if (rule) {
    rule.times -= 1;
    served += 1;
    // Drain what the caller sent, then answer the way the API's limiter does.
    req.resume();
    return json(
      res,
      429,
      { error: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      { 'retry-after': rule.retryAfter },
    );
  }

  const upstream = forward(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path,
      headers: { ...req.headers, host: target.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'PROXY_UPSTREAM' });
    else res.end();
  });
  req.pipe(upstream);
});

server.listen(port, () => console.log(`[fault proxy] http://localhost:${port} -> ${target.origin}`));
