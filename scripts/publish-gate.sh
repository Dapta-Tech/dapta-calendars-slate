#!/usr/bin/env bash
#
# Publish gate — the hard check that must pass before this repo is ever made
# public, and on every PR so the tree stays publishable. Three layers:
#   1. gitleaks    — secret patterns (keys, tokens, credentialed URLs)
#   2. trufflehog  — high-entropy + verified-secret detection (second engine)
#   3. an internal-token grep — the project-specific denylist the generic
#      scanners don't know about.
#
# Layers 1 & 2 are skipped with a warning if the tools aren't installed locally
# (CI installs them). Layer 3 always runs — it needs nothing but grep.
#
# Usage: bash scripts/publish-gate.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAIL=0

echo "== publish-gate: internal-token scan =="
# The denylist: internal hosts, cloud/account markers, internal service names,
# and WIP markers that must never reach public history. Extend as needed.
# Matched case-insensitively (grep -i) so "Aurora"/"aurora" both trip it.
PATTERN='dapta\.(ai|dev)|daptatech|amazonaws|aurora|\bbooking_ms\b|dapta_lab|dapta-iam|integration\.app|apps-configs-flux2|DO[ -]NOT[ -]MERGE'

# Scan tracked/working files, excluding vendored/build/self paths. The deploy/
# overlay is gitignored (never in public history) so it is not scanned here.
MATCHES=$(grep -RInEi "$PATTERN" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir=.next \
  --exclude-dir=.turbo \
  --exclude-dir=deploy \
  --exclude=publish-gate.sh \
  . 2>/dev/null)

if [ -n "$MATCHES" ]; then
  echo "FAIL: internal tokens found in tree:"
  echo "$MATCHES"
  FAIL=1
else
  echo "OK: no internal tokens found."
fi

echo
echo "== publish-gate: author-identity scan (git history) =="
# Internal author/committer identities must be curated (squash/relabel to a
# neutral identity) before the repo is flipped public — see opensource-standards
# §4. Non-fatal here so CI stays green pre-publish; flip to FAIL=1 once history
# has been curated so a regression is caught.
AUTHOR_HITS=$(git log --format='%ae%n%ce' 2>/dev/null | sort -u | grep -iE 'daptatech|@dapta\.(ai|dev|com)' || true)
if [ -n "$AUTHOR_HITS" ]; then
  echo "WARN: internal author/committer emails in history (curate before publish):"
  echo "$AUTHOR_HITS"
else
  echo "OK: no internal author identities in history."
fi

echo
echo "== publish-gate: gitleaks =="
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-banner --redact -v || FAIL=1
  gitleaks detect --no-git --no-banner --redact -v || FAIL=1
else
  echo "WARN: gitleaks not installed — skipped locally (runs in CI)."
fi

echo
echo "== publish-gate: trufflehog =="
# --exclude-paths: documented placeholders (see the exclude file's header) that
# the runner can't verify (no DB/DNS egress) and would fail as "unknown".
if command -v trufflehog >/dev/null 2>&1; then
  trufflehog filesystem --no-update --fail --results=verified,unknown \
    --exclude-paths scripts/publish-gate-exclude.txt . || FAIL=1
else
  echo "WARN: trufflehog not installed — skipped locally (runs in CI)."
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "publish-gate: FAILED — do not publish."
  exit 1
fi
echo "publish-gate: PASSED."
