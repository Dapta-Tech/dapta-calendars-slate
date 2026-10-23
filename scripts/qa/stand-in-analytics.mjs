#!/usr/bin/env node
// A stand-in for a product-analytics ingestion host, for the browser suite. It
// lets the suite run with analytics ON and assert exactly what would leave the
// browser and the API, without any third party. Run the apps with:
//
//   PRODUCT_ANALYTICS_PROVIDER=posthog
//   PRODUCT_ANALYTICS_KEY=<anything>
//   PRODUCT_ANALYTICS_HOST=http://127.0.0.1:<port>
//
// What it serves:
//   GET  /static/array.js  the REAL vendor library, from the web app's pinned
//                          `posthog-js` devDependency, so the suite sees every
//                          property the vendor adds on its own
//   GET  /static/[<version>/]exception-autocapture.js
//                          the library's error capture extension, from the same
//                          package (it asks for it when error tracking is on)
//   POST /e/ (and the vendor's other event paths)
//                          the browser's batches, decoded (gzip or base64) and
//                          recorded one event at a time
//   POST /capture/         the API's server-side events, recorded as sent
//   anything else          answered `{}` and recorded as a request, so a test
//                          can prove nothing else was asked for (flags,
//                          recordings, remote config)
//
// Test-only endpoints, all under /__qa:
//   GET  /__qa/events      every recorded event, oldest first
//   GET  /__qa/requests    every request path, oldest first
//   POST /__qa/reset       forget both
//
// Usage: node scripts/qa/stand-in-analytics.mjs [port]   (default 4520, or QA_ANALYTICS_PORT)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A file of the pinned library's `dist`, by name. */
function library(file = 'array.js') {
  const path = createRequire(resolve(root, 'apps/web/package.json')).resolve(`posthog-js/dist/${file}`);
  return readFileSync(path, 'utf8');
}

/** The library's own files this host serves: the library and its error capture extension, any version path. */
const STATIC_FILE = /^\/static\/(?:[\w.-]+\/)?(array\.js|exception-autocapture\.js)$/;

/** The browser's event paths, across the vendor's versions. */
const EVENT_PATHS = new Set(['/e/', '/i/v0/e/', '/batch/', '/track/', '/engage/']);

/** A browser batch, whatever its encoding, as a list of events. */
function decodeBatch(raw, url) {
  let buf = raw;
  if (url.searchParams.get('compression') === 'gzip-js' || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf);
  let text = buf.toString('utf8');
  if (text.startsWith('data=')) text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed.batch) ? parsed.batch : [parsed];
}

export function startStandInAnalytics(port = 0) {
  const events = [];
  const requests = [];
  const libs = new Map();

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://stand-in');
    const origin = req.headers.origin;
    const cors = origin
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': 'content-type',
          vary: 'origin',
        }
      : { 'access-control-allow-origin': '*' };
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, ...cors });
      res.end(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    };

    if (req.method === 'OPTIONS') return send(204, '');
    if (url.pathname.startsWith('/__qa/')) {
      if (req.method === 'GET' && url.pathname === '/__qa/events') return send(200, { events });
      if (req.method === 'GET' && url.pathname === '/__qa/requests') return send(200, { requests });
      if (req.method === 'POST' && url.pathname === '/__qa/reset') {
        events.length = 0;
        requests.length = 0;
        return send(200, {});
      }
      return send(404, { error: 'not found' });
    }

    requests.push({ method: req.method, path: url.pathname, at: Date.now() });
    const file = req.method === 'GET' ? STATIC_FILE.exec(url.pathname)?.[1] : undefined;
    if (file) {
      try {
        if (!libs.has(file)) libs.set(file, library(file));
      } catch (err) {
        return send(500, `/* posthog-js is not installed: ${String(err)} */`, 'application/javascript');
      }
      return send(200, libs.get(file), 'application/javascript');
    }
    if (req.method === 'POST' && url.pathname === '/capture/') {
      try {
        events.push({ source: 'server', at: Date.now(), ...JSON.parse(raw.toString('utf8')) });
      } catch {
        return send(400, { error: 'not json' });
      }
      return send(200, { status: 1 });
    }
    if (req.method === 'POST' && EVENT_PATHS.has(url.pathname)) {
      try {
        // The browser library carries the distinct id inside `properties`;
        // lifted to the top, where the API's events have it, so one predicate
        // reads both.
        for (const e of decodeBatch(raw, url)) {
          events.push({ source: 'browser', at: Date.now(), ...e, distinct_id: e.distinct_id ?? e.properties?.distinct_id });
        }
      } catch {
        return send(400, { error: 'undecodable batch' });
      }
      return send(200, { status: 1 });
    }
    return send(200, {});
  });

  return new Promise((resolveStart) => {
    server.listen(port, '127.0.0.1', () => resolveStart({ server, port: server.address().port, events, requests }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? process.env.QA_ANALYTICS_PORT ?? 4520);
  const { port: bound } = await startStandInAnalytics(port);
  console.log(`[stand-in-analytics] listening on http://127.0.0.1:${bound}`);
}
