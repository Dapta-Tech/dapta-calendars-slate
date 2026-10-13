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

function run(script: string, args: string[], opts: { onStart?: (child: ChildProcess) => void } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${QA}${script}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
