/** Page titles for the public surface: what a tab, a search result and a link preview say. */
import { t } from './i18n';

/**
 * The words of a text, folded for comparison: accents stripped, lowercased,
 * split on anything that is not a letter or a digit. "José's Q&A" is
 * `['jose', 's', 'q', 'a']`.
 */
function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether a title already names someone: their whole name, word for word and
 * in order, or their first name as a word of its own. "An interview with
 * Felipe" names "Felipe Gomez"; "Felipe's office hours" does too; "Intro call"
 * does not. A one-letter first name ("J. Smith") counts only as part of the
 * whole name, so "A quick call" never reads as naming "A. Ruiz".
 */
export function titleNames(title: string, name: string): boolean {
  const have = words(title);
  const want = words(name);
  if (want.length === 0) return false;
  const first = want[0]!;
  if (first.length > 1 && have.includes(first)) return true;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

/**
 * An event page's title. The catalog's template adds who the event is with
 * (`{event} with {name}`), but a host who already put themselves in the title
 * would read twice ("An interview with Felipe with Felipe"), so a title that
 * names them stands alone.
 */
export function eventPageTitle(template: string, event: string, name: string): string {
  return titleNames(event, name) ? event : t(template, { event, name });
}
