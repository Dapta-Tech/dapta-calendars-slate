// Next's ambient type declarations, pinned deliberately.
//
// These two references used to arrive via the generated `next-env.d.ts`, which
// is no longer committed: Next rewrites it on every run and flips its routes
// import between `.next/types` and `.next/dev/types`, so it churned unrelated
// PRs and fought between concurrent worktrees.
//
// Without this file the declarations it pulls in — `*.css` / `*.module.css`,
// `server-only`, the `NODE_ENV` narrowing — survive only because a handful of
// files happen to `import type { Metadata } from 'next'`. That is incidental,
// and deleting the last such import would break a fresh clone's typecheck for
// reasons nobody would connect back to here.
//
// This file is the STABLE half of what `next-env.d.ts` provided. It must never
// reference anything under `.next/`: that directory does not exist on a fresh
// checkout, and CI typechecks before it builds.

/// <reference types="next" />
/// <reference types="next/image-types/global" />
