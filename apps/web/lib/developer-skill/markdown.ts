/**
 * The two places a value read off the OpenAPI document lands in the skill's
 * markdown: an inline code span and a table cell. The value is the document's,
 * not ours, so each helper makes sure nothing in it can end the span or the
 * cell early. A value with no backtick, backslash or pipe comes out exactly as
 * it did before.
 */

/** A line ending as CommonMark reads one: CRLF, a lone CR or a lone LF. */
const LINE_ENDING = /\r\n?|\n/;

/**
 * `value` as an inline code span. The fence is one backtick longer than the
 * longest run of backticks in the value, and a value that starts or ends with
 * a backtick is padded with a space on both sides (which CommonMark strips back
 * off), so a backtick in the value cannot close the span. A line ending in the
 * value becomes a space, which is how CommonMark shows one inside a span, so it
 * cannot end the heading, paragraph or list item the span sits in either. A
 * value with neither gets the single-backtick span it always had.
 */
export function code(value: unknown): string {
  const text = (value === null ? 'null' : String(value)).split(LINE_ENDING).join(' ');
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * `text` on one line, safe inside a table cell. Every line ending (a lone CR
 * included) joins the trimmed lines with a space, since any of them would end
 * the row. A `|` would end the cell, so it becomes `\|`; every backslash is
 * doubled first, so one already in the text (a trailing one, or a `\|` of its
 * own) cannot pair with that escape and turn it back into a real pipe. Inside a
 * code span a doubled backslash shows as two, the price of a cell nothing can
 * break out of.
 */
export const tableCell = (text: string): string =>
  text
    .split(LINE_ENDING)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
