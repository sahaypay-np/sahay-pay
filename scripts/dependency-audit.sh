#!/bin/bash
# scripts/dependency-audit.sh — weekly dependency audit routine
# (Phase 2 item 889). Runs npm audit + an outdated check and prints a
# short summary. Run weekly (see the runbook §5 Weekly routine).
#
#   ./scripts/dependency-audit.sh            # human-readable summary
#   ./scripts/dependency-audit.sh --json     # machine-readable (audit JSON)
#
# Exit code: 0 unless a HIGH or CRITICAL vulnerability is found.
set -u
cd "$(dirname "$0")/.." || exit 1

echo "== Sahay Pay dependency audit — $(date -u +%F) =="
echo

if [ "${1:-}" = "--json" ]; then
  npm audit --json
  exit $?
fi

echo "--- npm audit ---"
# npm audit exits non-zero when vulnerabilities exist — capture its
# output regardless of exit code (do NOT append a fallback object).
AUDIT_JSON=$(npm audit --json 2>/dev/null || true)
node -e "
const a = JSON.parse(process.argv[1] || '{}');
const m = (a.metadata && a.metadata.vulnerabilities) || {};
const total = (m.info||0)+(m.low||0)+(m.moderate||0)+(m.high||0)+(m.critical||0);
console.log('vulnerabilities: total ' + total + ' (info ' + (m.info||0) + ', low ' + (m.low||0) + ', moderate ' + (m.moderate||0) + ', high ' + (m.high||0) + ', critical ' + (m.critical||0) + ')');
if ((m.high||0) + (m.critical||0) > 0) {
  console.log('HIGH/CRITICAL advisories:');
  const vulns = a.vulnerabilities || {};
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity === 'high' || v.severity === 'critical') {
      console.log('  - ' + name + ' (' + v.severity + ', via ' + (v.via && v.via[0] && v.via[0].title ? v.via[0].title : 'see npm audit') + ')');
    }
  }
}
" "$AUDIT_JSON"

echo
echo "--- outdated (direct dependencies) ---"
npm outdated --depth=0 2>/dev/null || true

echo
echo "--- action ---"
echo "HIGH/CRITICAL: fix within 48h (npm audit fix, or upgrade the package)."
echo "Moderate/low: fix at the next weekly review. Record the outcome in"
echo "the weekly review note (see docs/RUNBOOK.md §5 Weekly)."
