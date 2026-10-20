import { describe, expect, it } from 'vitest';
import { endpointsMd } from './endpoints-md';
import { code, tableCell } from './markdown';
import { parseOpenApi } from './openapi-doc';

/**
 * A table row's cells, split the strictest way a markdown parser does it: a
 * pipe ends a cell unless an odd number of backslashes stands right before it.
 */
const cells = (row: string): string[] => {
  const out: string[] = [];
  let current = '';
  let slashes = 0;
  for (const ch of row) {
    if (ch === '|' && slashes % 2 === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
    slashes = ch === '\\' ? slashes + 1 : 0;
  }
  out.push(current);
  return out.slice(1, -1).map((c) => c.trim());
};

/** What a reader gets back from a cell: each escaped backslash or pipe as the one character. */
const unescape = (cell: string): string => cell.replace(/\\([\\|])/g, '$1');

/** The text of an inline code span, read as CommonMark reads one. */
const spanText = (span: string): string | null => {
  const m = /^(`+)([\s\S]*?)\1$/.exec(span);
  if (!m || new RegExp(`(^|[^\`])${m[1]}([^\`]|$)`).test(m[2]!)) return null;
  const inner = m[2]!;
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '' ? inner.slice(1, -1) : inner;
};

describe('tableCell', () => {
  const row = (text: string) => `| ${tableCell(text)} | next |`;

  it('leaves text with nothing to escape as it was', () => {
    expect(tableCell('Use alone, or use one of the slug selector pairs.')).toBe(
      'Use alone, or use one of the slug selector pairs.',
    );
  });

  it('escapes a pipe, so it stays inside the cell', () => {
    expect(tableCell('ok | degraded')).toBe('ok \\| degraded');
    expect(cells(row('ok | degraded'))).toEqual(['ok \\| degraded', 'next']);
  });

  it('doubles a backslash', () => {
    expect(tableCell('C:\\temp')).toBe('C:\\\\temp');
    expect(unescape(tableCell('C:\\temp'))).toBe('C:\\temp');
  });

  it('keeps a backslash-pipe of the text from becoming a real pipe', () => {
    expect(tableCell('a\\|b')).toBe('a\\\\\\|b');
    expect(cells(row('a\\|b'))).toEqual(['a\\\\\\|b', 'next']);
    expect(unescape(cells(row('a\\|b'))[0]!)).toBe('a\\|b');
  });

  it('keeps a trailing backslash from escaping the pipe that ends the cell', () => {
    expect(tableCell('ends with \\')).toBe('ends with \\\\');
    expect(cells(`|${tableCell('ends with \\')}| next |`)).toEqual(['ends with \\\\', 'next']);
    expect(cells(`|${tableCell('pipe then slash |\\')}|`)).toEqual(['pipe then slash \\|\\\\']);
  });

  it('puts a value on several lines on one', () => {
    expect(tableCell('first line\n  second line\r\n\nthird')).toBe('first line second line third');
    expect(tableCell('\n trimmed \n')).toBe('trimmed');
  });
});

describe('code', () => {
  it('wraps a value with no backtick in one backtick each side, as before', () => {
    expect(code('Attendee')).toBe('`Attendee`');
    expect(code(42)).toBe('`42`');
    expect(code(null)).toBe('`null`');
    expect(code('a|b\\c')).toBe('`a|b\\c`');
  });

  it('fences a backtick in the value with a longer run, so it cannot close the span', () => {
    expect(code('a`b')).toBe('``a`b``');
    expect(code('a``b`c')).toBe('```a``b`c```');
  });

  it('pads a value that starts or ends with a backtick', () => {
    expect(code('`x')).toBe('`` `x ``');
    expect(code('x`')).toBe('`` x` ``');
  });

  it('reads back as the value it was given', () => {
    for (const value of ['plain', 'a`b', '``', '`', 'a``b`c', '`x`', 'x` y']) {
      expect(spanText(code(value)), value).toBe(value);
    }
  });
});

describe('the endpoint reference tables', () => {
  /** One operation whose parameters say everything a cell has to survive. */
  const doc = parseOpenApi({
    openapi: '3.1.0',
    paths: {
      '/things': {
        get: {
          summary: 'List things',
          parameters: [
            { name: 'pipe', in: 'query', description: 'ok | degraded' },
            { name: 'slash', in: 'query', description: 'C:\\temp' },
            { name: 'both', in: 'query', description: 'a\\|b' },
            { name: 'trailing', in: 'query', description: 'ends with \\' },
            { name: 'lines', in: 'query', description: 'first\nsecond' },
            { name: 'tick', in: 'query', schema: { enum: ['a`b', 'c|d'], default: 'x\\' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  })!;
  const md = endpointsMd(doc, { apiUrl: 'https://api.example.test' });
  const rows = md.split('\n').filter((l) => /^\| `/.test(l));

  it('keeps every row at five cells, whatever a description holds', () => {
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(cells(r), r).toHaveLength(5);
  });

  it('reads each value back as the document wrote it', () => {
    const notes = Object.fromEntries(rows.map((r) => [cells(r)[0], unescape(cells(r)[4]!)]));
    expect(notes).toMatchObject({
      '`pipe`': 'ok | degraded',
      '`slash`': 'C:\\temp',
      '`both`': 'a\\|b',
      '`trailing`': 'ends with \\',
      '`lines`': 'first second',
    });
    const tick = cells(rows[5]!);
    expect(unescape(tick[3]!)).toBe('``a`b`` or `c|d`');
    expect(unescape(tick[4]!)).toBe('Default `x\\`.');
  });
});
