import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A plain function, not a `vi.fn`: vitest fails a test whose mock throws even
// when the code under test catches it, and throwing is one of the cases here.
const nextAfter = vi.hoisted(() => ({
  calls: [] as unknown[],
  refuse: false,
}));
vi.mock('next/server', () => ({
  after: (task: unknown) => {
    nextAfter.calls.push(task);
    if (nextAfter.refuse) throw new Error('`after` was called outside a request scope');
  },
}));

import { loginStartedEvent, recordLoginStarted, scheduleLoginStarted, type LoginStart } from './login-started';

/**
 * `calendars_login_started`: what the login route records about a login start,
 * and that it can never slow or break the login itself.
 */

const ON = {
  NODE_ENV: 'test',
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: 'phc_test',
  PRODUCT_ANALYTICS_HOST: 'https://ingest.example.test',
} as unknown as NodeJS.ProcessEnv;

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LANDING_ID = '0192f0a4-7c1e-7d2b-9a3c-5e6f7a8b9c0d';

const start = (over: Partial<LoginStart> = {}): LoginStart => ({
  screen: 'sign-up',
  landingCookie: LANDING_ID,
  attributionCookie: JSON.stringify({ utm_source: 'linkedin', utm_campaign: 'q4', gclid: 'click-1' }),
  origin: 'https://app.dcal.example',
  userAgent: CHROME,
  at: new Date('2026-11-22T21:00:00.000Z'),
  ...over,
});

describe('loginStartedEvent', () => {
  it('files a start under the landing id, with the screen, the campaign source and the host', () => {
    expect(loginStartedEvent(start())).toEqual({
      event: 'calendars_login_started',
      distinct_id: LANDING_ID,
      timestamp: '2026-11-22T21:00:00.000Z',
      properties: {
        product: 'calendars',
        screen: 'sign-up',
        has_ph_id: true,
        utm_source: 'linkedin',
        $host: 'app.dcal.example',
        $geoip_disable: true,
      },
    });
  });

  it('without a landing id: a random id and no person profile', () => {
    const body = loginStartedEvent(start({ landingCookie: undefined, screen: 'sign-in' }), () => 'r-1');
    expect(body).toMatchObject({
      distinct_id: 'calendars-login-r-1',
      properties: { screen: 'sign-in', has_ph_id: false, $process_person_profile: false },
    });
  });

  it('refuses a landing id that is not id-shaped, like the middleware does', () => {
    const body = loginStartedEvent(start({ landingCookie: 'ana@example.com' }), () => 'r-2');
    expect(body?.distinct_id).toBe('calendars-login-r-2');
    expect(JSON.stringify(body)).not.toContain('ana@example.com');
  });

  it('carries only the source of the parked tags, and only a plain label', () => {
    const clean = JSON.stringify(loginStartedEvent(start()));
    expect(clean).not.toContain('q4');
    expect(clean).not.toContain('click-1');

    const email = loginStartedEvent(start({ attributionCookie: JSON.stringify({ utm_source: 'ana@example.com' }) }));
    expect(email?.properties).not.toHaveProperty('utm_source');
    expect(loginStartedEvent(start({ attributionCookie: 'not json' }))?.properties).not.toHaveProperty('utm_source');
    expect(loginStartedEvent(start({ attributionCookie: undefined }))?.properties).not.toHaveProperty('utm_source');
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'curl/8.4.0',
    'WhatsApp/2.23.20.0 A',
    'Viber/13.3.0.16',
  ])('sends nothing for an automated client (%s)', (userAgent) => {
    expect(loginStartedEvent(start({ userAgent }))).toBeNull();
  });

  it('sends nothing without a user agent', () => {
    expect(loginStartedEvent(start({ userAgent: null }))).toBeNull();
  });
});

describe('recordLoginStarted', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('posts one capture to the configured host with the write key', async () => {
    await recordLoginStarted(start(), ON, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; signal?: unknown }];
    expect(url).toBe('https://ingest.example.test/capture/');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body)).toMatchObject({ api_key: 'phc_test', event: 'calendars_login_started' });
  });

  it('does nothing with analytics off', async () => {
    await recordLoginStarted(start(), { NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws: a dead connection or a refused key is one warning', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(recordLoginStarted(start(), ON, fetchMock)).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(recordLoginStarted(start(), ON, fetchMock)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleLoginStarted', () => {
  beforeEach(() => {
    nextAfter.calls = [];
    nextAfter.refuse = false;
  });

  it('hands the send to after(), so the redirect never waits on it', () => {
    scheduleLoginStarted(start());
    expect(nextAfter.calls).toHaveLength(1);
    expect(typeof nextAfter.calls[0]).toBe('function');
  });

  it('swallows after() refusing outside a request', () => {
    nextAfter.refuse = true;
    expect(() => scheduleLoginStarted(start())).not.toThrow();
    expect(nextAfter.calls).toHaveLength(1);
  });
});
