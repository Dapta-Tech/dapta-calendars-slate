# `develop` promotes to `main` whole, never cherry-picked

## Context

Both pilot environments run core `main`, currently seven weeks stale, while
`develop` sits nine commits ahead and undeployed (#72). Three of those commits
are security fixes — one-way idempotency inputs, credential-tainted hashing,
separated request fingerprints — so production runs unpatched for as long as the
gap stays open.

The obvious shortcut is to cherry-pick just those three onto `main`: a small,
low-risk change that patches production without shipping the 5,912-line
Cal-compatible `/v2` slice that makes up the rest of the gap, and which this
effort never reviewed.

The shortcut looks cheap because the current branch relationship is invisible
when it is healthy. Today `main` is a **strict content subset** of `develop` —
`git log main ^develop --no-merges` is empty, and `main`'s seven extra commits
are all merges *of* `develop`. Nothing on `main` is missing from `develop`, which
is why a `develop → main` PR is always a clean fast-forward-shaped merge with no
back-merge and no conflict.

A cherry-pick ends that. The picked commits land on `main` with new SHAs, so
`main` permanently holds commits `develop` lacks by identity even when it holds
them by content. Every subsequent release PR then carries that divergence, and
the deploy runbook's documented conflict pattern (image-tag bumps colliding on
`develop → main`) becomes the normal case rather than an edge one. The damage is
not the first cherry-pick — it is that the invariant, once broken, cannot be
restored without a history rewrite.

## Decision

`develop` is **always `main` plus one step**: the same tree, one step ahead.
Promotion is the only way code reaches `main`, and it promotes `develop`
**whole**.

Nothing is ever cherry-picked, force-pushed, or committed directly onto `main`.
A fix urgent enough to bypass the queue still lands on `develop` first and is
promoted immediately after — urgency changes the *speed* of a promotion, never
its shape.

Concretely, this makes the release loop: agent opens the PR → Josue merges →
dev environment deploys `develop` → Josue tests → agent opens the
`develop → main` PR → Josue merges → production deploys.

## Consequences

**Good.** A release PR is always mergeable with no back-merge step, so promotion
stays a mechanical, low-ceremony act that can run continuously rather than
accumulating into a launch-day event. `main` is always exactly a past state of
`develop`, which makes "what is in production" answerable by a single
`git log main ^develop` returning empty. Rollback stays a redeploy of a recorded
image digest, never a revert of divergent history.

**Bad.** A security fix cannot reach production faster than everything else
already queued on `develop`. That is the real cost, and it is paid in exactly the
situation this ADR was written in: three fixes waited seven weeks behind an
unreviewed feature slice. The mitigation is cadence, not exception — promoting
continuously keeps the queue short enough that "everything ahead of it" is never
more than a feature or two. If the queue is ever long enough that this hurts,
the queue is the bug.

**Also bad.** Promoting whole means promoting code this effort did not review.
The `/v2` slice ships because it is on `develop`, not because the pilot needs it.
Review debt is tracked as review debt; it is not paid down by branch surgery.
