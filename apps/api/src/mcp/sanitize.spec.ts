import { describe, expect, it } from 'vitest';
import { trimSlash } from '../oauth/oauth.settings';
import { untrusted } from './support';

describe('untrusted: invitee text never opens a tag', () => {
  it.each([
    ['an unclosed tag', 'hi <script'],
    ['a nested tag', '<<script>script>alert(1)</script>'],
    ['a split tag', '<scr<b>ipt>x'],
    ['a comment or doctype opener', 'x <!-- y <!doctype'],
    ['a closing-tag opener', 'x </div'],
  ])('%s leaves no tag opener', (_label, input) => {
    expect(untrusted(input)).not.toMatch(/<[A-Za-z!/?]/);
  });

  it('keeps the readable words', () => {
    expect(untrusted('Hello <b>Ada</b>, see [my site](http://evil.test)')).toBe('Hello Ada, see my site');
  });

  it.each(['<10', '10-50', '>50', '> 50', 'a < b', 'budget > 5k', '<= 3', '1<2'])(
    'round-trips %s exactly (select options and answers must match)',
    (value) => {
      expect(untrusted(value, 100)).toBe(value);
    },
  );

  it('cuts a huge value before the regexes, so it stays fast', () => {
    const started = performance.now();
    for (const ch of ['<', '[', '!', '(']) expect(untrusted(ch.repeat(200_000)).length).toBeLessThanOrEqual(500);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('trimSlash: linear on caller-controlled input', () => {
  it.each([
    ['https://a.test/mcp/', 'https://a.test/mcp'],
    ['https://a.test/mcp///', 'https://a.test/mcp'],
    ['/', ''],
    ['', ''],
    ['https://a.test', 'https://a.test'],
  ])('%s -> %s', (input, out) => {
    expect(trimSlash(input)).toBe(out);
  });

  it('handles a long run of slashes followed by a character quickly', () => {
    const hostile = `${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimSlash(hostile)).toBe(hostile);
    expect(trimSlash(`${hostile}${'/'.repeat(100_000)}`)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
