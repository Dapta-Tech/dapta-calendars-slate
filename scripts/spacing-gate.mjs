#!/usr/bin/env node
/**
 * Spacing gate — padding, margins and gaps come from the scale, not from a
 * number somebody picked.
 *
 * Why this is a gate. Before the scale existed, an audit of the 60 `.tsx` files
 * under `apps/web/app/admin` and `apps/web/components` found **74 distinct
 * values across 17 spacing roles** — 9 different `gap-*` steps over 283 uses, 10
 * `px-*` over 127. Nothing lined up because nothing said what to line up to, and
 * every new screen re-decided from scratch. The sweep fixed the tree once; only
 * this gate keeps it fixed, exactly as `glyph-gate.mjs` does for its own rule.
 *
 * The scale lives in `packages/shared/src/tokens.css` (`--sp-*`, with the
 * reasoning) and reaches Tailwind through the `@theme` block in
 * `apps/web/app/globals.css`, which turns it into `p-card`, `gap-field`,
 * `px-gutter`, `min-h-control` and the rest. Name the ROLE; the value follows.
 *
 * What fails: a numeric spacing utility (`gap-3`, `px-2.5`, `mt-6`) in a swept
 * file. What passes: the role utilities, the zeros (`px-0` is "remove the
 * padding", not a rhythm decision), negative-margin optical nudges expressed
 * through a role (`-ml-field`), and the handful of allowlisted call sites below,
 * each of which says why.
 *
 * Deliberately NOT covered: the public booking surfaces. `booking-flow.tsx`,
 * `booking-page-parts.tsx`, `made-with-badge.tsx` and `branded-shell.tsx` live
 * under `apps/web/components` but render `apps/web/app/[accountCode]`, where the
 * spacing comes from the booking page's own `--bp-pad` / `--bp-gap` axes — the
 * host's settings, not this scale. They are skipped by name below, because the
 * directory does not separate them.
 *
 * Usage: node scripts/spacing-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `gap-3`, `px-2.5`, `-mt-6`, `space-y-4` … The longer prefixes come first so
 * `px-` is never matched as `p-`, and the trailing guard keeps arbitrary values
 * (`h-[44px]`), fractions (`w-1/2`) and longer words out.
 */
const PREFIX = String.raw`(?:gap-x|gap-y|gap|space-x|space-y|ps|pe|px|py|pt|pb|pl|pr|ms|me|mx|my|mt|mb|ml|mr|p|m)`;
const NUMERIC_SPACING = new RegExp(String.raw`(?<![\w-])-?${PREFIX}-\d+(?:\.5)?(?![\w./[-])`, 'g');

/**
 * The other half, and the one the first sweep missed: an ARBITRARY value is a
 * number too. `min-h-[44px]` is how the tap-target floor was written at 38 sites
 * before `min-h-control` existed, and `p-[18px]` is how a swept file would drift
 * back without ever tripping the numeric pattern.
 */
const ARBITRARY_SPACING = new RegExp(String.raw`(?<![\w-])-?${PREFIX}-\[[^\]]+\]`, 'g');

/**
 * The tap-target floor, specifically. `min-h-[44px]` is how R28 was written at 38
 * sites before `min-h-control` existed, and it is the one arbitrary HEIGHT the
 * scale owns — every other `h-[…]` is the size of a thing, not a rhythm step.
 */
const HAND_WRITTEN_TAP_TARGET = /(?:min-)?h-\[44px\]/g;

/** `px-0` and friends: "no padding here" is not a rhythm decision. */
const ZERO = /-0$/;

/**
 * An arbitrary size is only a spacing decision when it is one. A percentage, a
 * viewport unit or a calc is a layout constraint; a fixed px length is the thing
 * the scale exists to replace.
 */
const ARBITRARY_IS_LENGTH = /-\[\d+(?:\.\d+)?px\]$/;

/**
 * One entry per forgiven call site: the file, a substring that must appear on
 * the line, and why the scale does not apply. Anything else fails.
 */
const ALLOW = [
  {
    file: 'apps/web/app/admin/availability/schedule-editor.tsx',
    utility: 'pl-32',
    why: "Indents the row's error under its controls by the width of the day-label column. It tracks that column, so a rhythm step would misalign it the moment the column changes.",
  },
  {
    file: 'apps/web/components/setup-checklist.tsx',
    utility: 'pl-9',
    why: "Clears the icon column so the action lines up with the text beside it — the icon's width, not a rhythm step.",
  },
  {
    file: 'apps/web/components/field-help.tsx',
    utility: '-m-3.5',
    why: 'Half of (the 44px tap target minus the 16px mark), so the control keeps a 16px layout footprint. It tracks those two, not the rhythm — a rounded value moves every caller.',
  },
  {
    file: 'apps/web/app/admin/error.tsx',
    utility: 'py-16',
    why: 'A whole-section failure state is a deliberate void, not a padded row; it is taller than any content rhythm on purpose.',
  },
];

/**
 * Matched against the UTILITY, not the line. Line-scoped forgiveness silently
 * pardons every other hit that happens to share the line.
 */
function allowed(file, utility) {
  return ALLOW.some((a) => a.file === file && a.utility === utility);
}

/** Rendered by the public booking page, governed by its own `--bp-*` axes. */
const PUBLIC_SURFACES = new Set([
  'apps/web/components/booking-flow.tsx',
  'apps/web/components/booking-page-parts.tsx',
  'apps/web/components/made-with-badge.tsx',
  'apps/web/components/branded-shell.tsx',
]);

/** Comments are not rendered, so a number in one is not a spacing decision. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

const files = execFileSync(
  'git',
  ['ls-files', 'apps/web/app/admin', 'apps/web/components'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f.endsWith('.tsx'))
  .filter((f) => !PUBLIC_SURFACES.has(f));

/**
 * A file can fence a region out with `spacing-gate:off` / `spacing-gate:on`. The
 * `off` marker must carry a reason on the same comment — the studio's booking
 * preview is the case it exists for: admin chrome and the host's own BP canvas
 * share one file, and only the chrome is on this scale.
 */
const FENCE_OFF = /spacing-gate:off/;
const FENCE_ON = /spacing-gate:on/;

const failures = [];
for (const file of files) {
  const raw = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
  const lines = stripComments(raw.join('\n')).split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    // Read the fence from the RAW line: the markers live in comments, which
    // `stripComments` has already blanked.
    if (FENCE_OFF.test(raw[i])) fenced = true;
    else if (FENCE_ON.test(raw[i])) fenced = false;
    if (fenced) return;
    for (const hit of line.match(NUMERIC_SPACING) ?? []) {
      if (ZERO.test(hit)) continue;
      if (allowed(file, hit)) continue;
      failures.push(`${file}:${i + 1}  ${hit}`);
    }
    for (const hit of line.match(ARBITRARY_SPACING) ?? []) {
      if (!ARBITRARY_IS_LENGTH.test(hit)) continue;
      if (allowed(file, hit)) continue;
      failures.push(`${file}:${i + 1}  ${hit}`);
    }
    for (const hit of line.match(HAND_WRITTEN_TAP_TARGET) ?? []) {
      failures.push(`${file}:${i + 1}  ${hit}  (use min-h-control)`);
    }
  });
}

/**
 * The silent failure this gate would otherwise miss entirely: a role declared in
 * `tokens.css` with no `--spacing-*` line in the app's `@theme` block generates
 * NO utility. `p-<role>` then sets no padding at all, typecheck passes, this
 * gate passes (the class is not numeric), and the spacing is simply gone. Both
 * new rungs in this sweep needed that line added by hand.
 */
const SHEET = readFileSync(resolve(ROOT, 'packages/shared/src/tokens.css'), 'utf8');
const THEME = readFileSync(resolve(ROOT, 'apps/web/app/globals.css'), 'utf8');
const declared = [...SHEET.matchAll(/--sp-([a-z-]+)\s*:/g)].map((m) => m[1]);
const mapped = new Set([...THEME.matchAll(/--spacing-[a-z-]+:\s*var\(--sp-([a-z-]+)\)/g)].map((m) => m[1]));
for (const role of declared) {
  if (!mapped.has(role)) {
    failures.push(
      `apps/web/app/globals.css  --sp-${role} has no --spacing-* mapping, so no utility exists for it`,
    );
  }
}

if (failures.length) {
  console.error('FAIL — spacing picked by number instead of by role:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\n${failures.length} site(s). Use the scale: p-card, gap-field, px-gutter sm:px-gutter-wide,` +
      '\nmin-h-control … The roles and their values are in packages/shared/src/tokens.css.' +
      '\nIf a value genuinely tracks something other than the rhythm (an icon\'s width, a fixed' +
      '\noverlay), add it to ALLOW in this file with the reason.',
  );
  process.exit(1);
}

console.log(`ok — ${files.length} files carry no numeric spacing utility`);
