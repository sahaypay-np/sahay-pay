#!/bin/bash
# tests/check-live.sh — READ-ONLY live checks (checklist items 797/940).
# Run after every deploy against the live site. GET requests only; creates
# NO data and touches NO authenticated endpoints. Never run the other
# suites (smoke.sh / contract.sh / spa-harness.js) against live.
#
#   ./tests/check-live.sh [BASE]
#   BASE defaults to https://sahay-pay.netlify.app
set -u
B="${1:-${BASE:-https://sahay-pay.netlify.app}}"
B="${B%/}"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS: $1"; }
bad()  { fail=$((fail+1)); echo "FAIL: $1"; }

# 1. Homepage returns 200.
code=$(curl -s -o /tmp/cl-home.html -w '%{http_code}' -m 15 "$B/") || code=000
[ "$code" = "200" ] && ok "homepage returns 200" || bad "homepage returns 200 (got $code)"
grep -q "Sahay Pay" /tmp/cl-home.html 2>/dev/null && ok "homepage contains brand" || bad "homepage contains brand"

# 2. Health endpoint is ok.
health=$(curl -s -m 15 "$B/api/health") || health=""
echo "$health" | grep -q '"ok":true' && ok "/api/health is ok" || bad "/api/health is ok (got: $health)"

# 3. robots.txt loads and names the sitemap.
code=$(curl -s -o /tmp/cl-robots.txt -w '%{http_code}' -m 15 "$B/robots.txt") || code=000
[ "$code" = "200" ] && ok "robots.txt loads (200)" || bad "robots.txt loads (got $code)"
grep -q "Sitemap:" /tmp/cl-robots.txt 2>/dev/null && ok "robots.txt names the sitemap" || bad "robots.txt names the sitemap"

# 4. sitemap.xml loads and is valid XML with the homepage URL.
code=$(curl -s -o /tmp/cl-sitemap.xml -w '%{http_code}' -m 15 "$B/sitemap.xml") || code=000
[ "$code" = "200" ] && ok "sitemap.xml loads (200)" || bad "sitemap.xml loads (got $code)"
grep -q "<urlset" /tmp/cl-sitemap.xml 2>/dev/null && grep -q "sahay-pay.netlify.app/" /tmp/cl-sitemap.xml && ok "sitemap.xml contains homepage URL" || bad "sitemap.xml contains homepage URL"

# 5. security.txt loads AND is the real file (not the SPA fallback page:
#    the fallback returns 200 for every path, so check the content).
code=$(curl -s -o /tmp/cl-security.txt -w '%{http_code}' -m 15 "$B/.well-known/security.txt") || code=000
[ "$code" = "200" ] && grep -q "^Contact:" /tmp/cl-security.txt 2>/dev/null && ok "security.txt loads (200, real file)" || bad "security.txt loads as the real file (got $code)"

# 6. Manifest loads AND parses as JSON with the app name.
code=$(curl -s -o /tmp/cl-manifest.json -w '%{http_code}' -m 15 "$B/manifest.webmanifest") || code=000
if [ "$code" = "200" ] && node -e "const m=require('/tmp/cl-manifest.json'); if(m.name!=='Sahay Pay') process.exit(1);" 2>/dev/null; then
  ok "manifest.webmanifest loads (200, valid JSON)"
else
  bad "manifest.webmanifest loads as valid JSON (got $code)"
fi

# 7. Security headers present on the homepage.
headers=$(curl -s -I -m 15 "$B/") || headers=""
for h in "Strict-Transport-Security" "Content-Security-Policy" "X-Frame-Options" "X-Content-Type-Options" "Referrer-Policy" "Permissions-Policy"; do
  echo "$headers" | grep -qi "^$h:" && ok "header present: $h" || bad "header present: $h"
done

# 8. Unknown API route returns JSON 404.
resp=$(curl -s -w '\n%{http_code}' -m 15 "$B/api/does-not-exist") || resp="000"
rcode=$(echo "$resp" | tail -1); rbody=$(echo "$resp" | head -n -1)
[ "$rcode" = "404" ] && ok "unknown API route returns 404" || bad "unknown API route returns 404 (got $rcode)"
echo "$rbody" | grep -q '"error"' && ok "unknown API route returns JSON error" || bad "unknown API route returns JSON error (got: $rbody)"

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
