import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The admin screen header system. Consistent shapes so every admin surface
 * behaves the same (Design Quality Bar: one system, predictable back-nav):
 *
 *  • PageHeader — LIST / index pages. Title (+ optional subtitle) on the left,
 *    a single primary action (the green Create) top-right. No nested headers.
 *  • StatementHeader: SETTINGS and HOME. Title plus a one-line statement of
 *    what the page holds, both at title size.
 *  • FormHeader — CREATE / EDIT pages. A back affordance to the parent list,
 *    the record title, and optional sticky actions (Save) top-right. Sticky so
 *    the primary action stays reachable while the form scrolls.
 *
 * A list page uses ONLY PageHeader; a detail page uses ONLY FormHeader — never
 * both stacked (that was the "double header" bug on /availability).
 */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-group flex items-start justify-between gap-field">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-tight text-muted-foreground">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * The header of a SETTINGS area or a home screen: the title in ink and, on a
 * second line at the same size, what the area holds in the faint voice, so the
 * page opens with a statement rather than a title and a 14px caption. The
 * statement has to be short (it is set at heading size).
 */
export function StatementHeader({
  title,
  statement,
  action,
}: {
  title: string;
  statement: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-section flex flex-wrap items-end justify-between gap-x-group gap-y-card">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-3xl font-bold tracking-tight text-faint">{statement}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Sticky detail-page header. The bleed (`-mx-gutter px-gutter`) pulls the surface
 * and its border out to the container's padding edges, so the backdrop covers the
 * full width as content scrolls under it. Place as the first child of a page
 * container with the same gutter.
 *
 * It uses the GUTTER roles, not the content ones: the bleed has to track the page
 * gutter, and `--sp-page-x` and `--sp-card` agreeing at 16px today is a
 * coincidence, not a rule. Tie it to the wrong one and the sticky bar stops short
 * of the page edge the first time the gutter moves.
 */
export function FormHeader({
  backHref,
  backLabel,
  title,
  actions,
  gutter = 'lg',
}: {
  backHref: string;
  backLabel: string;
  title: ReactNode;
  actions?: ReactNode;
  /**
   * Which container padding this header bleeds to. `lg` is the original
   * full-gutter-everywhere container; `responsive` matches a
   * `px-gutter sm:px-gutter-wide` one —
   * the shape A2 (#112) gives its pages so 360px keeps a 16px gutter instead of
   * 32. The bleed and the container must agree or the sticky bar stops short of
   * the page edge, so this is a prop rather than a guess.
   */
  gutter?: 'lg' | 'responsive';
}) {
  const bleed =
    gutter === 'responsive'
      ? '-mx-gutter px-gutter sm:-mx-gutter-wide sm:px-gutter-wide'
      : '-mx-gutter-wide px-gutter-wide';
  return (
    <div
      className={`sticky top-0 z-20 mb-group border-b border-border bg-background/90 pb-card pt-group backdrop-blur supports-[backdrop-filter]:bg-background/75 ${bleed}`}
    >
      <Link
        href={backHref}
        className="-ml-tight inline-flex min-h-control items-center gap-tight px-tight text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <i aria-hidden className="pi pi-chevron-left" style={{ fontSize: 12 }} />
        {backLabel}
      </Link>
      <div className="mt-inline flex flex-wrap items-center justify-between gap-field">
        <div className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">{title}</div>
        {actions ? <div className="flex shrink-0 items-center gap-inline">{actions}</div> : null}
      </div>
    </div>
  );
}
