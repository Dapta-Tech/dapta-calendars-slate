import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * The hand-run QA scripts (scripts/qa) send real traffic, so each one checks
 * where it is pointed before the first request, and cleans up after itself.
 * Run here as child processes against a stand-in API on loopback; no other
 * host is ever contacted (`.example.test` never resolves).
 */
const QA = fileURLToPath(new URL('../../../scripts/qa/', import.meta.url));

interface Run {
  code: number | null;
  stderr: string;
  stdout: string;
}

function run(
  script: string,
  args: string[],
  opts: { onStart?: (child: ChildProcess) => void; nodeArgs?: string[] } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), `${QA}${script}`, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    opts.onStart?.(child);
  });
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
const servers: Server[] = [];
async function standIn(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, body, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const PAGE = ['--page', 'acme/alex-rivera/intro-call'];

describe('the QA scripts refuse a target nobody meant', () => {
  for (const script of ['hold-race.mjs', 'load-availability.mjs', 'rate-limit-probe.mjs']) {
    it(`${script}: a non-loopback --api is refused without the flag, before any request`, async () => {
      const out = await run(script, ['--api', 'https://calendars.example.test', ...PAGE]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain('not loopback');
      expect(out.stderr).toContain('--i-know-this-is-not-prod');
    });

    it(`${script}: a host on --deny-hosts is refused even with the flag`, async () => {
      const out = await run(script, [
        '--api',
        'https://api.calendars.example.test',
        ...PAGE,
        '--i-know-this-is-not-prod',
        '--deny-hosts',
        'other.example.test,calendars.example.test',
      ]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain('--deny-hosts');
    });
  }

  it('the flag lets a non-loopback target through to the network (and the flag takes no value)', async () => {
    // `.example.test` never resolves, so getting past the guard shows as a
    // fetch failure, not as the guard's exit 2.
    const out = await run('rate-limit-probe.mjs', [
      '--api',
      'https://calendars.example.test',
      '--i-know-this-is-not-prod',
      ...PAGE,
    ]);
    expect(out.stderr).toContain('going ahead because --i-know-this-is-not-prod');
    expect(out.code).not.toBe(2);
  });

  it('a name is never taken for loopback, even when DNS answers 127.0.0.1 (rebinding)', async () => {
    // Every lookup in the script's process answers loopback, as a rebinding
    // host would for the check; fetch would resolve the name again later and
    // could reach a remote API. Only a literal loopback host is accepted.
    const rebinding =
      "import dns from 'node:dns'; import dnsp from 'node:dns/promises'; import { syncBuiltinESMExports } from 'node:module';" +
      "dnsp.lookup = async (_h, o) => (o && o.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 });" +
      "dns.lookup = (_h, o, cb) => { const done = typeof o === 'function' ? o : cb; const all = typeof o === 'object' && o && o.all;" +
      "  process.nextTick(() => (all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4))); };" +
      'syncBuiltinESMExports();';
    const nodeArgs = ['--import', `data:text/javascript,${encodeURIComponent(rebinding)}`];
    const hook = await run(
      'webhook-check.mjs',
      ['--api', 'http://rebind.example.test:4411', '--public', 'https://tunnel.example.test', '--host-email', 'alex@example.com', ...PAGE],
      { nodeArgs },
    );
    expect(hook.code).toBe(2);
    expect(hook.stderr).toContain('only runs against a local API');
    const race = await run('hold-race.mjs', ['--api', 'http://rebind.example.test:4411', ...PAGE], { nodeArgs });
    expect(race.code).toBe(2);
    expect(race.stderr).toContain('not loopback');
  });

  it('literal loopback hosts are accepted without the flag', async () => {
    // The stand-in refuses everything, so getting past the guard shows as the
    // script's own failure (exit 1), never the guard's exit 2.
    const api = await standIn((_req, _body, res) => json(res, 500, {}));
    const port = new URL(api).port;
    for (const host of ['127.0.0.1', 'localhost']) {
      const out = await run('rate-limit-probe.mjs', ['--api', `http://${host}:${port}`, ...PAGE, '--max', '1']);
      expect(out.code, host).toBe(1);
      expect(out.stderr, host).not.toContain('refusing');
    }
  });

  it('webhook-check.mjs runs against a local API only, with no override', async () => {
    const out = await run('webhook-check.mjs', [
      '--api',
      'https://calendars.example.test',
      '--public',
      'https://tunnel.example.test',
      '--host-email',
      'alex@example.com',
      ...PAGE,
      '--i-know-this-is-not-prod',
    ]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('only runs against a local API');
  });
});

describe('the QA scripts clean up after themselves', () => {
  it('hold-race.mjs, interrupted mid-race, gives back the hold it won before exiting', async () => {
    const released: string[] = [];
    let sawHold!: () => void;
    const holding = new Promise<void>((r) => (sawHold = r));
    let wins = 0;
    const api = await standIn((req, body, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/v1/availability') return json(res, 200, { slots: [{ startUtc: '2026-11-02T15:00:00.000Z' }] });
      if (path === '/v1/reservations/release') {
        released.push((JSON.parse(body) as { reservationUid: string }).reservationUid);
        return json(res, 200, { ok: true });
      }
      if (path === '/v1/reservations') {
        // The first visitor wins at once; everyone else hangs, so the race is
        // still running when the signal lands.
        if (wins++ === 0) {
          json(res, 201, { reservationUid: 'hold-1' });
          return sawHold();
        }
        return;
      }
      json(res, 404, {});
    });
    const out = await run('hold-race.mjs', ['--api', api, ...PAGE, '--visitors', '3'], {
      onStart: (child) => void holding.then(() => setTimeout(() => child.kill('SIGINT'), 200)),
    });
    expect(out.code).toBe(130);
    expect(out.stderr).toContain('releasing 1 hold(s)');
    expect(released).toEqual(['hold-1']);
  });

  it('webhook-check.mjs cancels the booking it made, and deletes its webhooks', async () => {
    const calls: string[] = [];
    const api = await standIn((req, _body, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      calls.push(`${req.method} ${path}`);
      if (req.method === 'POST' && path === '/v1/webhooks') return json(res, 201, { id: `wh-${calls.length}` });
      if (path === '/v1/availability') return json(res, 200, { slots: [{ startUtc: '2026-11-02T15:00:00.000Z' }] });
      if (req.method === 'POST' && path === '/v1/bookings') return json(res, 201, { uid: 'bk-check' });
      if (req.method === 'POST' && path === '/v1/host/bookings/bk-check/cancel')
        return json(res, 200, { uid: 'bk-check', status: 'cancelled' });
      if (req.method === 'DELETE') return json(res, 200, { ok: true });
      json(res, 404, {});
    });
    const out = await run('webhook-check.mjs', [
      '--api',
      api,
      '--public',
      'https://tunnel.example.test',
      '--host-email',
      'alex@example.com',
      ...PAGE,
      '--port',
      '0',
      '--watch',
      '0',
    ]);
    // No deliveries reach a stand-in, so the check itself fails; the cleanup
    // must happen anyway.
    expect(out.code).toBe(1);
    expect(calls).toContain('POST /v1/host/bookings/bk-check/cancel');
    expect(calls.filter((c) => c.startsWith('DELETE /v1/webhooks/'))).toHaveLength(2);
    expect(out.stdout).toContain("cancelled the check's booking bk-check");
  });
});
