#!/bin/bash
# scripts/check-secrets.sh — grep-based secret scan for CI (checklist item 163).
#
# Fails if the working tree looks like it contains a real secret:
#   - a real .env file present in the checkout (.env.example is fine)
#   - API-key / credential patterns in tracked files
# Excludes: .env.example (placeholders), this script itself (it names the
# patterns), node_modules, .git, data/, and lines that are clearly
# placeholders (user:pass@, example values, <angle-bracket> placeholders,
# $(...) generated values, the documented test bridge secret).
# This is a tripwire, not a guarantee — CodeQL + review are the other layers.
set -u
cd "$(dirname "$0")/.." || exit 1

fail=0

if [ -f .env ]; then
  echo "FAIL: .env file present in the checkout — real secrets must never live in the repo tree."
  fail=1
fi

# Patterns that look like real secrets. Written with a split so this file
# does not match its own patterns (it is also excluded from the scan).
P1='sk-[A-Za-z0-9]{20,}'            # OpenAI-style API key
P2='AKI''A[0-9A-Z]{16}'             # AWS access key id
P3='BEGIN .*PRIVATE KEY'            # PEM private key
P4='ghp_[A-Za-z0-9]{20,}'           # GitHub personal access token
P5='github_pat_[A-Za-z0-9_]{20,}'   # GitHub fine-grained token
P6='xox[baprs]-[A-Za-z0-9-]{10,}'   # Slack token
P7='SESSION_SECRET=[^$< "]{16,}'    # SESSION_SECRET with a literal long value
P8='PAYOUT_ENCRYPTION_KEY=[^$< "]{16,}'
P9='postgres://[^ /]*:[^ /]*@'      # Postgres URL carrying credentials

# Allowlist: placeholder / documentation lines that legitimately match a pattern.
ALLOW='user:pass@|example\.com|example-|changeme|YOUR_|<[^>]*>|test-bridge-secret|\$\(|placeholder|example\.js|docs/|README\.md|ARCHITECTURE\.md'

# Scan the working tree (tracked AND untracked files — a secret in a new
# file must fail before it is ever committed).
FILES=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./data -prune -o -type f -print | sed 's|^\./||' | grep -v -e '^\.env\.example$' -e '^scripts/check-secrets\.sh$' -e '^\.githooks/pre-commit$')

for pat in "$P1" "$P2" "$P3" "$P4" "$P5" "$P6" "$P7" "$P8" "$P9"; do
  hits=$(echo "$FILES" | xargs -r grep -InE "$pat" 2>/dev/null | grep -vE "$ALLOW" || true)
  if [ -n "$hits" ]; then
    echo "FAIL: possible secret matching /$pat/:"
    echo "$hits" | sed 's/\(.\{60\}\).*/\1... [redacted]/'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "secret scan: OK (no secret patterns found)"
  exit 0
fi
echo "secret scan: FAILED — remove the secret, rotate it, and re-run."
exit 1
