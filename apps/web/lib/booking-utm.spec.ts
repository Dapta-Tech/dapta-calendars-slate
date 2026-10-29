// @vitest-environment jsdom
/**
 * The campaign a booking keeps: the booking page's own `utm_*` (first value of
 * each, cleaned), and, embedded without any, the framing page's, asked of its
 * `embed.js` and taken only from the parent window, once, within a few
 * seconds. And `embed.js`'s half: it answers only frames it placed, to the
 * origin that asked, with its own page's five `utm_*` and nothing else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BOOKING_UTM_VALUE } from '@slate/types';
import {
  CONTEXT_MESSAGE,
  CONTEXT_REQUEST_MESSAGE,
  CONTEXT_RETRY_MS,
  CONTEXT_WAIT_MS,
  requestHostUtm,
  utmFromQuery,
} from '@/lib/booking-utm';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

describe('utmFromQuery', () => {
  it('takes the five utm_* keys, the first value of each, cleaned', () => {
    expect(
      utmFromQuery({ utm_source: [' google ', 'bing'], utm_campaign: 'q4', utm_medium: '', gclid: 'x', embed: '1' }),
    ).toEqual({ utm_source: 'google', utm_campaign: 'q4' });
  });

  it('is null for a page without any', () => {
    expect(utmFromQuery({ embed: '1' })).toBeNull();
    expect(utmFromQuery(undefined)).toBeNull();
  });

  it('is an empty campaign when the address names a key but no value survives, so the framing page is not asked', () => {
    expect(utmFromQuery({ utm_source: '' })).toEqual({});
    expect(utmFromQuery({ utm_campaign: 'x'.repeat(MAX_BOOKING_UTM_VALUE + 1) })).toEqual({});
  });
});

describe('requestHostUtm', () => {
  const answer = (data: unknown, source: MessageEventSource | null = window.parent) =>
    window.dispatchEvent(new MessageEvent('message', { data, source }));

  it('asks the parent, then takes one cleaned answer from it', () => {
    const post = vi.spyOn(window.parent, 'postMessage');
    const got = vi.fn();
    requestHostUtm(got);
    expect(post).toHaveBeenCalledWith({ type: CONTEXT_REQUEST_MESSAGE }, '*');
    answer({ type: CONTEXT_MESSAGE, utm: { utm_source: 'newsletter', other: 'x' } });
    answer({ type: CONTEXT_MESSAGE, utm: { utm_source: 'second' } });
    expect(got.mock.calls).toEqual([[{ utm_source: 'newsletter' }]]);
  });

  it('ignores answers from any window but the parent, and other messages', () => {
    const got = vi.fn();
    requestHostUtm(got);
    const stranger = document.createElement('iframe');
    document.body.appendChild(stranger);
    answer({ type: CONTEXT_MESSAGE, utm: { utm_source: 'spoof' } }, stranger.contentWindow);
    answer({ type: 'dapta-calendars:resize', height: 900 });
    expect(got).not.toHaveBeenCalled();
  });

  it('asks again while it waits, so an embed.js that loads late still answers, and stops once answered', () => {
    vi.useFakeTimers();
    const post = vi.spyOn(window.parent, 'postMessage');
    const got = vi.fn();
    requestHostUtm(got);
    vi.advanceTimersByTime(CONTEXT_RETRY_MS[1] + 1);
    expect(post).toHaveBeenCalledTimes(3);
    answer({ type: CONTEXT_MESSAGE, utm: { utm_source: 'late-loader' } });
    expect(got.mock.calls).toEqual([[{ utm_source: 'late-loader' }]]);
    vi.advanceTimersByTime(CONTEXT_WAIT_MS);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('gives up after the wait, and an empty answer gives nothing', () => {
    vi.useFakeTimers();
    const got = vi.fn();
    requestHostUtm(got);
    vi.advanceTimersByTime(CONTEXT_WAIT_MS + 1);
    answer({ type: CONTEXT_MESSAGE, utm: { utm_source: 'late' } });
    expect(got).not.toHaveBeenCalled();
    requestHostUtm(got);
    answer({ type: CONTEXT_MESSAGE, utm: null });
    expect(got).not.toHaveBeenCalled();
  });
});

describe('embed.js answers the booking page with its own page’s campaign', () => {
  const script = readFileSync(join(__dirname, '../public/embed.js'), 'utf8');

  function load() {
    // The snippet is a plain script: run it as one, in this window.
    new Function(script)();
  }

  it('to a frame it placed, at the origin that asked, with the five utm_* only', () => {
    window.history.replaceState({}, '', '/landing?utm_source=google&utm_campaign=q4&gclid=abc&utm_term=' + 'x'.repeat(200));
    load();
    const frame = document.createElement('iframe');
    frame.setAttribute('data-dapta-calendars', '');
    document.body.appendChild(frame);
    const reply = vi.spyOn(frame.contentWindow!, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CONTEXT_REQUEST_MESSAGE },
        source: frame.contentWindow,
        origin: 'https://book.example.com',
      }),
    );
    expect(reply).toHaveBeenCalledWith(
      { type: CONTEXT_MESSAGE, utm: { utm_source: 'google', utm_campaign: 'q4' } },
      'https://book.example.com',
    );
  });

  it('to nobody else', () => {
    window.history.replaceState({}, '', '/landing?utm_source=google');
    load();
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    const reply = vi.spyOn(other.contentWindow!, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: CONTEXT_REQUEST_MESSAGE }, source: other.contentWindow, origin: 'https://x.example' }),
    );
    expect(reply).not.toHaveBeenCalled();
  });
});
