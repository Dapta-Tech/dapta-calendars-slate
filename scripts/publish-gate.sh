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
# the private integration platform behind CALENDAR_BACKEND_MODULE (R15 — both
# its domain and its product name), and WIP markers that must never reach
# public history. Extend as needed.
# Matched case-insensitively (grep -i) so "Aurora"/"aurora" both trip it.
#
# R15 entries hide one letter in a character class: `int[e]gration` matches
# exactly the same strings as `integration`, but THIS FILE ships in the public
# repo, so a plain-text search of it must not hand over the name the gate is
# there to keep out. Add any future vendor entry the same way, and leave the
# trailing `\b` off so `NameWire`/`NameConnector` still trip it.
#
# R15_PATTERN is held separately because it is the one group that must also be
# absent from git HISTORY (scanned further down) — the internal hosts and WIP
# markers are a working-tree concern. It is spliced into PATTERN below, so a new
# vendor is still added in exactly one place.
R15_PATTERN='int[e]gration\.app|m[e]mbrane'
PATTERN="[a-z0-9-]+\.dapta\.(ai|dev)|daptatech|amazonaws|aurora|\bbooking_ms\b|dapta_lab|dapta-iam|${R15_PATTERN}|apps-configs-flux2|DO[ -]NOT[ -]MERGE"
# Product-PUBLIC hosts (our own public web/API/platform hosts) are not leaks —
# they may appear anywhere in the public repo. Internal service hosts stay blocked.
PUBLIC_HOST_ALLOW='\b(app|www|calendars?(-api)?)\.dapta\.(ai|dev)\b'
# The customer-facing support address is intentionally public product copy, not
# an internal host, credential, or employee identity.
PUBLIC_EMAIL_ALLOW='support@daptatech\.com'

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
  . 2>/dev/null | grep -vE "$PUBLIC_HOST_ALLOW" | grep -vE "$PUBLIC_EMAIL_ALLOW" || true)

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
echo "== publish-gate: R15 vendor scan (git history) =="
# The tree scan above cannot see history. A vendor name that was committed and
# later removed is still one `git log --grep` away for anyone who clones the
# repo, so history has to be curated (reword/squash) before the flip to public.
#
# Scoped to R15_PATTERN rather than the whole denylist on purpose: the internal
# hosts and the `daptatech` co-author trailer already surface in the
# author-identity scan above, and re-reporting them here would bury this signal
# in noise. Non-fatal for the same reason as that scan — flip to FAIL=1 once
# history has been curated, so a regression is caught.
#
# Prints SHAs and a count ONLY, never the matching text: this output lands in CI
# logs, which are public the moment the repo is.
R15_MSG=$(git log --regexp-ignore-case --extended-regexp --grep="$R15_PATTERN" --format='%H' 2>/dev/null || true)
R15_BLOB=$(git log --regexp-ignore-case --pickaxe-regex -S"$R15_PATTERN" --format='%H' 2>/dev/null || true)
R15_HITS=$(printf '%s\n%s\n' "$R15_MSG" "$R15_BLOB" | grep -v '^$' | sort -u || true)
if [ -n "$R15_HITS" ]; then
  echo "WARN: R15 vendor tokens in git history (curate before publish):"
  echo "$R15_HITS" | head -10 | sed 's/^/  /'
  echo "  $(echo "$R15_HITS" | wc -l | tr -d ' ') commit(s) total; text withheld (this log is public)."
else
  echo "OK: no R15 vendor tokens in history."
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
# Scans EVERY repo file — including .env.example and the docker-compose files,
# exactly where credentials get pasted by mistake. The exclude file skips only
# vendored/build infrastructure (node_modules, dist, …), never repo content.
# A documented placeholder that false-positives is allowlisted BY FINDING
# (detector + file + line) in publish-gate-allowlist.txt — never by whole file.
if command -v trufflehog >/dev/null 2>&1; then
  ALLOW="scripts/publish-gate-allowlist.txt"
  # A missing allowlist is broken gate config, not a clean scan — fail loudly
  # rather than let the filter degrade (every finding would read as new, or a
  # zero-finding run would mask the drift entirely).
  if [ ! -f "$ALLOW" ]; then
    echo "FAIL: $ALLOW is missing — the finding-level allowlist must exist (may be all comments)."
    FAIL=1
  fi
  TH_JSON=$(mktemp) TH_ERR=$(mktemp)
  trufflehog filesystem --no-update --results=verified,unknown --json \
    --exclude-paths scripts/publish-gate-exclude.txt . >"$TH_JSON" 2>"$TH_ERR"
  TH_EXIT=$?
  if [ "$TH_EXIT" -ne 0 ]; then
    # A crashed scanner is a FAILED gate, never a silent pass: no scan happened.
    echo "FAIL: trufflehog exited $TH_EXIT — the scan did not complete:"
    tail -5 "$TH_ERR"
    FAIL=1
  else
    # One key per finding: DetectorName:path:line (path relative to the root).
    FOUND=$(node -e '
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (l) => {
        try {
          const f = JSON.parse(l);
          if (!f.DetectorName) return;
          const meta = f.SourceMetadata?.Data?.Filesystem ?? {};
          const file = String(meta.file ?? "").replace(/^(\.\/)+/, "");
          console.log(`${f.DetectorName}:${file}:${meta.line ?? 0}`);
        } catch { /* non-JSON log line — ignore */ }
      });' <"$TH_JSON")
    NEW=""
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      grep -qxF "$key" "$ALLOW" 2>/dev/null || NEW="${NEW}${key}"$'\n'
    done <<<"$FOUND"
    if [ -n "$NEW" ]; then
      echo "FAIL: trufflehog findings not in the allowlist (DetectorName:file:line):"
      printf '%s' "$NEW"
      echo "A real credential must be rotated + removed. Only a DOCUMENTED placeholder"
      echo "may be added to $ALLOW (one line per finding)."
      FAIL=1
    else
      echo "OK: trufflehog clean (no unallowlisted findings)."
    fi
  fi
  rm -f "$TH_JSON" "$TH_ERR"
else
  echo "WARN: trufflehog not installed — skipped locally (runs in CI)."
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "publish-gate: FAILED — do not publish."
  exit 1
fi
echo "publish-gate: PASSED."
