/**
 * Which language a document is in: the admin's saved choice, else the
 * browser's; a public page's `?lang=`, else the browser's. The root layout
 * stamps `<html lang>` from the same answer the page renders in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  headers: {} as Record<string, string>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'slate_locale' && request.cookie !== undefined ? { value: request.cookie } : undefined,
  }),
  headers: async () => ({ get: (name: string) => request.headers[name.toLowerCase()] ?? null }),
}));

import { documentLocale, getLocale, isLinkPreviewRobot, negotiateLocale, publicLocale, statedLocale } from './locale';

beforeEach(() => {
  request.cookie = undefined;
  request.headers = {};
});

describe('negotiateLocale', () => {
  it('takes the first supported language the browser lists', () => {
    expect(negotiateLocale('es-CO,es;q=0.9,en;q=0.8')).toBe('es');
    expect(negotiateLocale('en-US,en;q=0.9,es;q=0.8')).toBe('en');
  });

  it('honors weights over the order they are written in', () => {
    expect(negotiateLocale('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.5')).toBe('es');
    expect(negotiateLocale('en;q=0.4, es;q=0.6')).toBe('es');
  });

  it('never picks a language the browser refuses (q=0)', () => {
    expect(negotiateLocale('es;q=0, en;q=0.1')).toBe('en');
    expect(negotiateLocale('es;q=0.0')).toBe('en');
  });

  it('ignores a weight it cannot read instead of taking it as a refusal', () => {
    expect(negotiateLocale('es;q=banana')).toBe('es');
    expect(negotiateLocale('es;q=, en;q=0.5')).toBe('es');
  });

  it('is English for a header that names neither, or none at all', () => {
    expect(negotiateLocale('fr-FR,de;q=0.8')).toBe('en');
    expect(negotiateLocale('*')).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
  });
});

describe('getLocale (admin, onboarding, sign-in)', () => {
  it("follows the browser's language when nothing was saved", async () => {
    request.headers['accept-language'] = 'es-MX,es;q=0.9';
    expect(await getLocale()).toBe('es');
  });

  it('keeps the language the switcher saved, whatever the browser says', async () => {
    request.headers['accept-language'] = 'es-MX,es;q=0.9';
    request.cookie = 'en';
    expect(await getLocale()).toBe('en');
    request.headers['accept-language'] = 'en-US';
    request.cookie = 'es';
    expect(await getLocale()).toBe('es');
  });

  it('is English with no cookie and no header', async () => {
    expect(await getLocale()).toBe('en');
  });
});

describe('publicLocale', () => {
  it('reads ?lang= from the forwarded query when the page passes none', async () => {
    request.headers['accept-language'] = 'en-US';
    request.headers['x-slate-query'] = '?lang=es&utm_source=x';
    expect(await publicLocale()).toBe('es');
  });

  it('lets an explicit lang win over everything', async () => {
    request.headers['x-slate-query'] = '?lang=es';
    expect(await publicLocale('en')).toBe('en');
  });

  it("falls back to the browser's language", async () => {
    request.headers['accept-language'] = 'es-AR';
    expect(await publicLocale()).toBe('es');
  });
});

/**
 * A link preview is drawn by a robot, which states no language of its own (the
 * mission's check: Slack's sends no `Accept-Language`). Its words then follow
 * the host's language, the one the event's title is written in; `?lang=` still
 * wins, and a person with a browser language is answered exactly as before.
 */
describe('publicLocale with the host language (link previews)', () => {
  const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

  it("answers a robot that states no language in the host's language", async () => {
    request.headers['user-agent'] = SLACK;
    expect(await publicLocale(undefined, 'es')).toBe('es');
  });

  it("ignores a preview robot's own language header for the host's", async () => {
    request.headers['user-agent'] = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
    request.headers['accept-language'] = 'en-US,en;q=0.9';
    expect(await publicLocale(undefined, 'es')).toBe('es');
    request.headers['user-agent'] = 'WhatsApp/2.24.6.77 A';
    expect(await publicLocale(undefined, 'es')).toBe('es');
    request.headers['user-agent'] = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
    expect(await publicLocale(undefined, 'es')).toBe('es');
  });

  it('keeps English for anyone else with no language header, so a crawler gets one language', async () => {
    // Search crawlers send no header either; their page body and <html lang>
    // know no host, so the title must not switch alone.
    expect(await publicLocale(undefined, 'es')).toBe('en');
    request.headers['user-agent'] = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    expect(await publicLocale(undefined, 'es')).toBe('en');
  });

  it('still lets ?lang= win over the host language, for a robot too', async () => {
    request.headers['user-agent'] = SLACK;
    request.headers['x-slate-query'] = '?lang=en';
    expect(await publicLocale(undefined, 'es')).toBe('en');
    expect(await publicLocale('en', 'es')).toBe('en');
  });

  it("keeps a person's browser language over the host's", async () => {
    request.headers['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
    request.headers['accept-language'] = 'en-US,en;q=0.9';
    expect(await publicLocale(undefined, 'es')).toBe('en');
    // A browser that names neither language keeps today's answer, English.
    request.headers['accept-language'] = 'fr-FR';
    expect(await publicLocale(undefined, 'es')).toBe('en');
  });

  it('is English for a robot when the host has no language on record', async () => {
    request.headers['user-agent'] = SLACK;
    expect(await publicLocale(undefined, null)).toBe('en');
  });

  it("answers a robot exactly as before on a page that knows no host", async () => {
    request.headers['user-agent'] = 'WhatsApp/2.24.6.77 A';
    request.headers['accept-language'] = 'es-CO';
    expect(await publicLocale()).toBe('es');
  });
});

describe('statedLocale / isLinkPreviewRobot', () => {
  it('names the preview robots and nothing a person browses with', () => {
    for (const ua of [
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Slackbot 1.0 (+https://api.slack.com/robots)',
      'facebookexternalhit/1.1 Facebot Twitterbot/1.0',
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
    ]) {
      expect(isLinkPreviewRobot(ua), ua).toBe(true);
    }
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36 Edg/131',
      '',
    ]) {
      expect(isLinkPreviewRobot(ua), ua).toBe(false);
    }
    expect(isLinkPreviewRobot(null)).toBe(false);
  });

  it("is null for a preview robot, the header's answer for anyone else", () => {
    expect(statedLocale('es-CO', 'Slackbot 1.0')).toBeNull();
    expect(statedLocale(null, 'Slackbot 1.0')).toBeNull();
    expect(statedLocale(null, null)).toBe('en');
    expect(statedLocale('  ', 'Mozilla/5.0')).toBe('en');
    expect(statedLocale('es-CO', 'Mozilla/5.0')).toBe('es');
    expect(statedLocale('fr-FR', 'Mozilla/5.0')).toBe('en');
  });
});

describe('documentLocale', () => {
  it("answers a product route with the admin's language", async () => {
    request.headers['x-slate-path'] = '/admin/event-types';
    request.headers['x-slate-query'] = '?lang=es';
    request.cookie = 'en';
    expect(await documentLocale()).toBe('en');
  });

  it("answers a booking page with the visitor's language", async () => {
    request.headers['x-slate-path'] = '/acme/alex-rivera/intro-call';
    request.headers['accept-language'] = 'es-CO';
    request.cookie = 'en';
    expect(await documentLocale()).toBe('es');
  });

  it('treats a missing path header as public', async () => {
    request.headers['x-slate-query'] = '?lang=es';
    expect(await documentLocale()).toBe('es');
  });
});
