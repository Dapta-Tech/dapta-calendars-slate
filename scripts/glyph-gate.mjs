#!/usr/bin/env node
/**
 * Glyph gate — no arrow, chevron or triangle CHARACTER may be rendered as a
 * control.
 *
 * Why this is a gate and not a review note: the rule was already agreed and
 * applied per unit, and each new unit then re-introduced the glyphs in files
 * outside its own scope. It was reported three separate times on three separate
 * screens in one afternoon. A rule that lives only in a reviewer's head does not
 * survive parallel work; this one is arithmetic.
 *
 * What is wrong with them: `→` after a link is not a control. It has no hit
 * target, no focus ring and no hover state, and a screen reader announces "right
 * arrow" in the middle of the label. The repo ships a Button primitive
 * (`apps/web/components/ui/button.tsx`) and an icon font (`pi-chevron-right`,
 * `pi-chevron-left`) that do the same job properly.
 *
 * What is FINE, and why the allowlist exists: an arrow inside a sentence, as a
 * breadcrumb through a UI ("Settings → Members"). That is prose, not a control.
 * Each allowlist entry names its reason.
 *
 * Scope is deliberately narrow — `.tsx` (what renders) plus the i18n catalog
 * (what renders through them). A glyph in a comment is stripped before matching,
 * and a glyph in a server-side log line is not a control.
 *
 * Usage: node scripts/glyph-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The glyphs. Not an exhaustive Unicode arrow sweep — these are the ones this
 * codebase has actually reached for. Note what is NOT here: `«»`, which are
 * Spanish quotation marks and appear in real copy.
 */
const GLYPHS = /[→←↑↓▸▾▴►◄↗⟶⇒]/u;

/**
 * One entry per forgiven line: the file it may appear in, a substring that must
 * be on the line, and why it is allowed. Anything else fails.
 *
 * The match forgives the WHOLE line, so keep an allowlisted string on a line of
 * its own — appending a control to one of these lines would ride in behind it.
 */
const ALLOW = [
  {
    file: 'packages/shared/src/i18n/index.ts',
    contains: 'Settings → Integrations → Private Apps',
    why: "a breadcrumb through HubSpot's own UI, inside a sentence of setup instructions",
  },
  {
    file: 'packages/shared/src/i18n/index.ts',
    contains: 'Configuración → Integraciones → Aplicaciones privadas',
    why: 'the same breadcrumb, in Spanish',
  },
  {
    file: 'packages/shared/src/i18n/index.ts',
    contains: 'from Settings → Members',
    why: 'a breadcrumb through our own settings, inside a sentence',
  },
  {
    file: 'packages/shared/src/i18n/index.ts',
    contains: 'desde Configuración → Miembros',
    why: 'the same breadcrumb, in Spanish',
  },
];

/**
 * Blank out comments so a `→` used to draw an arrow in an explanation does not
 * trip the gate. Newlines are preserved so line numbers survive.
 *
 * Block comments, including the JSX form, go wherever they appear. A `//` is
 * stripped when it starts the line, or when it follows whitespace — the two
 * shapes every comment in this repo actually takes. It is NOT stripped when it
 * follows `:` or `\`, which is what keeps `https://…` and a regex like
 * `/^https?:\/\//` from blanking the rest of their own line and hiding a real
 * glyph behind them.
 */
function stripComments(src) {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const m = /(^|\s)\/\//.exec(line);
      return m ? line.slice(0, m.index) : line;
    })
    .join('\n');
}

/*
 * `--others --exclude-standard` includes files that are not `git add`-ed yet, so
 * a brand-new component fails here BEFORE it reaches CI rather than after.
 */
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web', 'packages/shared/src/i18n/index.ts'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f.endsWith('.tsx') || f === 'packages/shared/src/i18n/index.ts');

/*
 * A gate that scans nothing passes everything. If the file list collapses — a
 * pathspec that stops matching, a move, a run from the wrong directory — that is
 * a failure, not a pass. The tree carries ~100 components; 50 is a floor well
 * clear of normal churn.
 */
const FLOOR = 50;
if (files.length < FLOOR) {
  console.error(
    `FAIL — the gate found only ${files.length} files to scan (expected at least ${FLOOR}).\n` +
      '       Something is wrong with the file list, not with the tree. A gate that\n' +
      '       scans nothing would pass everything, so this is a failure.',
  );
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const lines = stripComments(readFileSync(resolve(ROOT, file), 'utf8')).split('\n');
  lines.forEach((line, idx) => {
    if (!GLYPHS.test(line)) return;
    const forgiven = ALLOW.some((a) => a.file === file && line.includes(a.contains));
    if (forgiven) return;
    hits.push(`${file}:${idx + 1}: ${line.trim()}`);
  });
}

console.log('== glyph-gate: arrow glyphs rendered as controls ==');
if (hits.length > 0) {
  console.error(
    'FAIL — an arrow glyph is being rendered.\n' +
      '       Use the Button primitive (apps/web/components/ui/button.tsx) or the\n' +
      '       icon font (pi-chevron-right / pi-chevron-left) instead. If it is prose\n' +
      '       inside a sentence, add it to ALLOW in this file with a reason.\n',
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`ok — ${files.length} files scanned, no arrow glyph outside the allowlist`);
