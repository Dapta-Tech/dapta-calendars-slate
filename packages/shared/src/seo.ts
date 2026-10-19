/** Page titles for the public surface: what a tab, a search result and a link preview say. */
import { t } from './i18n';

/**
 * Small words that open names and titles alike ("The Growth Team", "La
 * Clínica", "De la Cruz") and so prove nothing on their own: a first name that
 * is one of these is matched only as part of the whole name.
 */
const NOT_A_FIRST_NAME = new Set([
  'a', 'an', 'the', 'of', 'and', 'with', 'for', 'to', 'in', 'on', 'at', 'by', 'my', 'our', 'your',
  'de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'con', 'para', 'por', 'en', 'al', 'un', 'una',
  'mi', 'tu', 'su', 'nuestro', 'nuestra',
]);

/**
 * The words of a text, folded for comparison: split on anything that is not a
 * letter or a digit, then accents stripped and lowercased. "José's Q&A" is
 * `['jose', 's', 'q', 'a']`. Split BEFORE folding, because a decomposed accent
 * is not a letter and would cut its word in two.
 */
function words(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
}

/**
 * Whether a title already names someone: their whole name, word for word and in
 * order, or (for a person) their first name as a word of its own. "An interview
 * with Ana" names "Ana Ruiz"; "Ana's office hours" does too; "Intro
 * call" does not.
 *
 * `firstName: false` asks for the whole name only, which is how a TEAM is
 * matched: "Meet the founders" must not read as naming "The Growth Team". A
 * person's first name counts unless it is one letter or a small word from
 * `NOT_A_FIRST_NAME`. When a common word happens to be a first name ("Mark your
 * calendar" for Mark Diaz) the title stands alone: losing "with Mark Diaz"
 * still reads right, which a doubled name never does.
 */
export function titleNames(title: string, name: string, { firstName = true } = {}): boolean {
  const have = words(title);
  const want = words(name);
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  const first = want[0]!;
  return firstName && first.length > 1 && !NOT_A_FIRST_NAME.has(first) && have.includes(first);
}

/**
 * An event page's title. The catalog's template adds who the event is with
 * (`{event} with {name}`), but a host who already put themselves in the title
 * would read twice ("An interview with Ana with Ana"), so a title that
 * names them stands alone. Pass `firstName: false` for a team (see `titleNames`).
 */
export function eventPageTitle(
  template: string,
  event: string,
  name: string,
  options: { firstName?: boolean } = {},
): string {
  return titleNames(event, name, options) ? event : t(template, { event, name });
}
