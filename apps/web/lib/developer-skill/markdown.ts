/**
 * The two places a value read off the OpenAPI document lands in the skill's
 * markdown: an inline code span and a table cell. The value is the document's,
 * not ours, so each helper makes sure nothing in it can end the span or the
 * cell early. A value with no backtick, backslash or pipe comes out exactly as
 * it did before.
 */

/**
 * `value` as an inline code span. The fence is one backtick longer than the
 * longest run of backticks in the value, and a value that starts or ends with
 * a backtick is padded with a space on both sides (which CommonMark strips back
 * off), so a backtick in the value cannot close the span. A value with none
 * gets the single-backtick span it always had.
 */
export function code(value: unknown): string {
  const text = value === null ? 'null' : String(value);
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * `text` on one line, safe inside a table cell. A `|` would end the cell, so
 * it becomes `\|`; every backslash is doubled first, so one already in the text
 * (a trailing one, or a `\|` of its own) cannot pair with that escape and turn
 * it back into a real pipe. Inside a code span a doubled backslash shows as
 * two, the price of a cell nothing can break out of.
 */
export const tableCell = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
