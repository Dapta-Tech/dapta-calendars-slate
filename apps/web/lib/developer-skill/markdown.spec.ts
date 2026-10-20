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

/** What a reader gets back from prose in a cell: each escaped backslash or pipe as the one character. */
const unescape = (cell: string): string => cell.replace(/\\([\\|])/g, '$1');

/**
 * What a reader gets back from a code span in a cell. GFM drops the backslash
 * of a `\|` before it reads the cell, but backslash escapes do nothing inside a
 * code span, so a doubled backslash there stays doubled.
 */
const unescapePipes = (cell: string): string => cell.replace(/\\\|/g, '|');

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

  it('treats a lone carriage return as the line ending it is', () => {
    expect(tableCell('a\rb')).toBe('a b');
    expect(tableCell('a \r\r b\r')).toBe('a b');
    expect(row('a\rb')).not.toMatch(/\r/);
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

  it('turns each line ending in the value into a space, so the span stays on its line', () => {
    expect(code('a\nb')).toBe('`a b`');
    expect(code('a\r\nb\rc')).toBe('`a b c`');
    expect(code('`x\n')).toBe('`` `x  ``');
  });

  it('measures any number of backtick runs', () => {
    expect(code('a`'.repeat(200_000))).toBe(`\`\` ${'a`'.repeat(200_000)} \`\``);
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
            { name: 'cr', in: 'query', description: 'a\rb' },
            { name: 'x|y', in: 'query|header' },
          ],
          responses: { 200: { description: 'ok' } },
        },
        post: {
          summary: 'Add a thing',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    'a|b': { type: 'string', description: 'A field with a pipe in its name.' },
                    plain: { type: 'string', description: 'one\rtwo' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'made' } },
        },
      },
    },
  })!;
  const md = endpointsMd(doc, { apiUrl: 'https://api.example.test' });
  const [listing, adding] = md.split('### `POST /things`');
  const rowsOf = (part: string | undefined) => part!.split('\n').filter((l) => /^\| `/.test(l));
  const params = rowsOf(listing);
  const fields = rowsOf(adding);

  it('keeps every row at the cells of its header, whatever a name or a description holds', () => {
    expect(md).not.toMatch(/\r/);
    expect(params).toHaveLength(8);
    for (const r of params) expect(cells(r), r).toHaveLength(5);
    expect(fields).toHaveLength(2);
    for (const r of fields) expect(cells(r), r).toHaveLength(4);
  });

  it('reads each value back as the document wrote it', () => {
    const notes = Object.fromEntries(params.map((r) => [cells(r)[0], unescape(cells(r)[4]!)]));
    expect(notes).toMatchObject({
      '`pipe`': 'ok | degraded',
      '`slash`': 'C:\\temp',
      '`both`': 'a\\|b',
      '`trailing`': 'ends with \\',
      '`lines`': 'first second',
      '`cr`': 'a b',
    });
    const tick = cells(params[5]!);
    expect(unescapePipes(tick[3]!)).toBe('``a`b`` or `c|d`');
    // The default is a code span: its backslash stays doubled, the trade-off `tableCell` names.
    expect(unescapePipes(tick[4]!)).toBe('Default `x\\\\`.');
    const piped = cells(params[7]!);
    expect(unescapePipes(piped[0]!)).toBe('`x|y`');
    expect(unescape(piped[1]!)).toBe('query|header');
    expect(fields.map((r) => unescapePipes(cells(r)[0]!))).toEqual(['`a|b`', '`plain`']);
    expect(unescape(cells(fields[1]!)[3]!)).toBe('one two');
  });
});
