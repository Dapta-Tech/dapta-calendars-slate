# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a change that should be released, run `pnpm changeset` and follow
the prompts. Commit the generated markdown file with your PR. Changesets are the
human-readable release notes for each change. Every package in this repo is
private and nothing is published, so no workflow versions packages or writes a
changelog from them.

CI runs `changeset status` on every PR; run `pnpm changeset status` to check
them first. One changeset may not mix the ignored apps (`@slate/web`,
`@slate/api`, see `config.json`) with the other packages: when a change touches
both, write one file for each group with the same summary.
