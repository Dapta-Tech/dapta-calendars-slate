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
//   GET  /static/array.js  a tiny library that honours the vendor loader stub's
//                          contract (the `_i` init queue, named instances, the
//                          `__SV` sentinel) and reports every call, after the
//                          app's own `before_send`, to /__qa/browser
//   POST /capture/         the API's server-side events, recorded as sent
//
// Test-only endpoints, all under /__qa:
//   GET  /__qa/events      everything recorded, oldest first
//   POST /__qa/reset       forget it
//
// Usage: node scripts/qa/stand-in-analytics.mjs [port]   (default 4520, or QA_ANALYTICS_PORT)
import { createServer } from 'node:http';

// The browser half. Plain ES5 so it runs anywhere the real one would. It keeps
// the app's settings as they were passed (minus functions) so a test can read
// what the app asked the vendor for, and it runs `before_send` the way the
// vendor does: on the finished event, dropping it when the hook returns null.
const LIBRARY = String.raw`(function () {
  var stub = window.posthog;
  if (stub && !Array.isArray(stub._i) && typeof stub.init === 'function') return;
  var script = document.currentScript;
  var origin = script && script.src ? new URL(script.src).origin : '';
  function post(message) {
    try {
      fetch(origin + '/__qa/browser', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(message),
        keepalive: true,
      });
    } catch (e) {}
  }
  function plain(config) {
    var out = {};
    for (var k in config) if (typeof config[k] !== 'function') out[k] = config[k];
    return out;
  }
  function Instance(key, config, name) {
    this.name = name;
    this.config = config || {};
    this.props = {};
    this.distinctId = 'anon-' + Math.random().toString(36).slice(2);
    post({ type: 'init', instance: name, config: plain(this.config) });
  }
  Instance.prototype.capture = function (event, properties) {
    var props = { distinct_id: this.distinctId, $current_url: location.href, $referrer: document.referrer || '$direct' };
    var k;
    for (k in this.props) props[k] = this.props[k];
    for (k in properties || {}) props[k] = properties[k];
    var data = { event: event, properties: props };
    if (typeof this.config.before_send === 'function') data = this.config.before_send(data);
    if (!data) return post({ type: 'dropped', instance: this.name, event: event });
    post({ type: 'capture', instance: this.name, event: data.event, properties: data.properties });
  };
  Instance.prototype.identify = function (id, set) {
    this.distinctId = id;
    post({ type: 'identify', instance: this.name, distinctId: id, set: set || null });
  };
  Instance.prototype.alias = function (alias) {
    post({ type: 'alias', instance: this.name, alias: alias });
  };
  Instance.prototype.register = function (properties) {
    for (var k in properties) this.props[k] = properties[k];
  };
  Instance.prototype.group = function (type, key, properties) {
    var groups = this.props.$groups || {};
    groups[type] = key;
    this.props.$groups = groups;
    post({ type: 'group', instance: this.name, groupType: type, groupKey: key, properties: properties || null });
  };
  Instance.prototype.reset = function () {
    this.props = {};
    this.distinctId = 'anon-' + Math.random().toString(36).slice(2);
    post({ type: 'reset', instance: this.name });
  };
  var main = {
    __SV: 1,
    init: function (key, config, name) {
      var instance = main[name] instanceof Instance ? main[name] : new Instance(key, config, name);
      main[name] = instance;
      return instance;
    },
  };
  var queue = (stub && stub._i) || [];
  for (var i = 0; i < queue.length; i++) {
    var item = queue[i];
    var name = item[2] || 'posthog';
    var pending = stub[name];
    var instance = main.init(item[0], item[1], name);
    if (Array.isArray(pending)) {
      for (var j = 0; j < pending.length; j++) {
        var call = pending[j];
        if (typeof instance[call[0]] === 'function') instance[call[0]].apply(instance, call.slice(1));
      }
    }
  }
  window.posthog = main;
})();`;

export function startStandInAnalytics(port = 0) {
  const events = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://stand-in');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
    const send = (status, json, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, ...cors });
      res.end(typeof json === 'string' ? json : JSON.stringify(json ?? {}));
    };

    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method === 'GET' && url.pathname === '/static/array.js') {
      return send(200, LIBRARY, 'application/javascript');
    }
    if (req.method === 'POST' && url.pathname === '/capture/') {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: 'not json' });
      }
      events.push({ source: 'server', at: Date.now(), ...body });
      return send(200, { status: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/__qa/browser') {
      try {
        events.push({ source: 'browser', at: Date.now(), ...JSON.parse(raw) });
      } catch {
        return send(400, { error: 'not json' });
      }
      return send(200, {});
    }
    if (req.method === 'GET' && url.pathname === '/__qa/events') return send(200, { events });
    if (req.method === 'POST' && url.pathname === '/__qa/reset') {
      events.length = 0;
      return send(200, {});
    }
    return send(404, { error: 'not found' });
  });

  return new Promise((resolveStart) => {
    server.listen(port, '127.0.0.1', () => resolveStart({ server, port: server.address().port, events }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? process.env.QA_ANALYTICS_PORT ?? 4520);
  startStandInAnalytics(port).then(({ port: p }) => {
    console.log(`[stand-in-analytics] listening on http://127.0.0.1:${p}`);
  });
}
