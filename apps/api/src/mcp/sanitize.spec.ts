import { describe, expect, it } from 'vitest';
import { trimSlash } from '../oauth/oauth.settings';
import { untrusted } from './support';

describe('untrusted: invitee text never forms a tag', () => {
  it.each([
    ['an unclosed tag', 'hi <script'],
    ['a nested tag', '<<script>script>alert(1)</script>'],
    ['a split tag', '<scr<b>ipt>x'],
    ['a stray closer', 'a > b < c'],
  ])('%s keeps no angle bracket', (_label, input) => {
    const out = untrusted(input);
    expect(out).not.toMatch(/[<>]/);
  });

  it('keeps the readable words', () => {
    expect(untrusted('Hello <b>Ada</b>, see [my site](http://evil.test)')).toBe('Hello Ada, see my site');
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
