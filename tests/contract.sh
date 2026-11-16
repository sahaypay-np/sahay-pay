#!/bin/bash
# Sahay Pay — frontend/backend contract tests (curl).
# Covers the integration fixes from the reconciliation pass: payout meta
# (bank name + branch), anonymous posts, boolean flags, prefs, country
# change, leaders/feed vocab, reveal shape, admin fees/methods shapes,
# hash-route notification links, onboarding photo, brand connect email.
# Usage: start the server first on a FRESH database, e.g.
#   rm -f data/sahay-pay.db*
#   PORT=3101 SESSION_SECRET=<random> PAYOUT_ENCRYPTION_KEY=<base64-32-bytes> \
#     CLAUDE_APPROVAL_BRIDGE_SECRET=test-bridge-secret node server/index.js
# then:  BASE=http://localhost:3101 ./tests/contract.sh
# Exits non-zero if any check fails. Test data lives in the local test DB only.

B="${BASE:-http://localhost:3101}/api"
J='-H Content-Type:application/json'
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; pass=$((pass+1)); else echo "FAIL: $1 — expected $2, got $3"; fail=$((fail+1)); fi; }
has() { if echo "$2" | grep -qF "$3"; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1 — missing: $3"; fail=$((fail+1)); fi; }
code() { echo "$1" | tail -1; }
body() { echo "$1" | sed '$d'; }
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# --- setup: admin PIN + two users ---
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/setup-pin" $J -d '{"pin":"123456"}'); t "admin setup-pin" 200 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"123456"}'); t "admin login" 200 "$(code "$r")"
T_ADMIN=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/csrf" | jget "['csrfToken']")
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-poster.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Asha Sharma","age":25,"country":"NP","city":"Bhairahawa","photoUrl":"/uploads/public/test-avatar.jpg","termsAccepted":true,"privacyAccepted":true}'); t "onboard poster (with photo)" 201 "$(code "$r")"
T_POSTER=$(curl -s -b "$TMPD/c-poster.txt" "$B/auth/csrf" | jget "['csrfToken']")
has "onboard stores photoUrl" "$(body "$r")" '/uploads/public/test-avatar.jpg'
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-helper.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Bikash Rai","age":30,"country":"NP","city":"Kathmandu","termsAccepted":true,"privacyAccepted":true}'); t "onboard helper" 201 "$(code "$r")"
T_HELPER=$(curl -s -b "$TMPD/c-helper.txt" "$B/auth/csrf" | jget "['csrfToken']")

# --- bill create: bank_np with bankName + branch, anonymous, booleans ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Electricity bill for June","category":"Electricity","company":"NEA","amountMinor":500000,"story":"My electricity bill is due and my salary is late this month.","city":"Bhairahawa","charity":false,"anonymous":true,"payDirect":false,"payoutMethods":[{"method":"bank_np","holderName":"Asha Sharma","account":"1234567890","bankName":"Nabil Bank","branch":"Bhairahawa"}],"submit":true}'); t "create bank_np bill (anonymous)" 201 "$(code "$r")"
BILL_ID=$(echo "$(body "$r")" | jget "['bill']['id']")
has "bill is anonymous" "$(body "$r")" '"anonymous":true'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Bad bank bill","category":"Rent","amountMinor":100000,"story":"This bill has no bank name so it must fail validation.","payoutMethods":[{"method":"bank_np","holderName":"Asha Sharma","account":"1234567890"}],"submit":true}'); t "bank_np without bankName -> 400" 400 "$(code "$r")"

# --- pay-direct bill: boolean true must stick, biller fields public ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Internet bill direct","category":"Internet","amountMinor":200000,"story":"Pay my ISP directly, please.","payDirect":true,"billerName":"WorldLink","billerRef":"WL-123","billerDestination":"WorldLink app, account WL-123","submit":true}'); t "create pay-direct bill" 201 "$(code "$r")"
PD_ID=$(echo "$(body "$r")" | jget "['bill']['id']")
has "payDirect true stored" "$(body "$r")" '"payDirect":true'

# --- charity bill: fee must be 0 ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Charity food drive","category":"Charity","amountMinor":300000,"story":"Raising money for the community food drive this month.","charity":true,"payoutMethods":[{"method":"esewa","holderName":"Asha Sharma","account":"9845671234"}],"submit":true}'); t "create charity bill" 201 "$(code "$r")"
CH_ID=$(echo "$(body "$r")" | jget "['bill']['id']")
has "charity true stored" "$(body "$r")" '"charity":true'

# --- approve all three via the admin queue ---
QUEUE=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/queue?status=pending")
for PID in $(echo "$QUEUE" | python3 -c "import sys,json;print(' '.join(p['id'] for p in json.load(sys.stdin)['packets']))"); do
  r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/review/$PID" $J -d '{"decision":"approve"}')
  t "approve packet ${PID:0:8}" 200 "$(code "$r")"
done

# --- feed: anonymous masking, payout hint, badges key, filters ---
FEED=$(curl -s -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?limit=20")
has "feed shows anonymous poster" "$FEED" '"displayName":"Anonymous"'
has "feed has payoutHint" "$FEED" 'payoutHint'
has "feed has badges array" "$FEED" '"badges"'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?amountBand=small"); t "feed amountBand param" 200 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?band=small"); t "feed band alias param" 200 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?payDirect=1"); t "feed payDirect param" 200 "$(code "$r")"
has "payDirect filter returns only direct bill" "$(body "$r")" 'Internet bill direct'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?city=Bhairahawa"); t "feed city param" 200 "$(code "$r")"
has "city filter matches Bhairahawa" "$(body "$r")" 'Electricity bill for June'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/feed?city=Nowhere"); t "feed city no-match" 200 "$(code "$r")"
has "city no-match is empty" "$(body "$r")" '"total":0'

# --- detail: biller destination + payout hint (non-owner) ---
r=$(curl -s -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/bills/$PD_ID")
has "detail has billerDestination" "$r" 'WorldLink app, account WL-123'
has "detail has payoutHint key" "$r" 'payoutHint'

# --- charity quote: fee 0 ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$CH_ID\",\"amountMinor\":100000}"); t "charity quote" 200 "$(code "$r")"
has "charity fee is 0" "$(body "$r")" '"feeMinor":0'

# --- gift flow on bank bill: reveal carries bankName + branch ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); t "bank bill quote" 200 "$(code "$r")"
has "quote fee 16000 (NPR flat)" "$(body "$r")" '"feeMinor":16000'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); t "gift create" 201 "$(code "$r")"
GIFT_ID=$(echo "$(body "$r")" | jget "['gift']['id']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/gifts/$GIFT_ID/reveal"); t "gift reveal" 200 "$(code "$r")"
has "reveal has payoutMethods array" "$(body "$r")" '"payoutMethods"'
has "reveal bankName" "$(body "$r")" 'Nabil Bank'
has "reveal branch" "$(body "$r")" 'Bhairahawa'
has "reveal account number" "$(body "$r")" '1234567890'

# --- leaders: canonical vocab + aliases + brands tab ---
r=$(curl -s -w '\n%{http_code}' "$B/leaders?tab=most_received&period=30d&scope=all"); t "leaders canonical vocab" 200 "$(code "$r")"
has "leaders echoes canonical tab" "$(body "$r")" '"tab":"most_received"'
r=$(curl -s "$B/leaders?tab=received&period=30"); has "leaders alias tab maps" "$r" '"tab":"most_received"'
has "leaders alias period maps" "$r" '"period":"30d"'
r=$(curl -s "$B/leaders?tab=brands"); has "leaders brands tab has mostResponded" "$r" 'mostResponded'
has "leaders brands tab has mostAsked" "$r" 'mostAsked'

# --- payout change: payoutMethods wrapper + branch, live bill goes back to review ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills/$BILL_ID/payout" $J -d '{"payoutMethods":[{"method":"bank_np","holderName":"Asha Sharma","account":"9999988888","bankName":"Global IME","branch":"Butwal"}]}'); t "payout change (wrapper shape)" 200 "$(code "$r")"
has "payout change sends live bill back to review" "$(body "$r")" '"backToReview":true'

# --- PATCH privateProofUrl persists (checked in the DB directly) ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/bills/$BILL_ID" $J -d '{"privateProofUrl":"/api/uploads/private/test-proof.pdf"}'); t "PATCH privateProofUrl" 200 "$(code "$r")"
DBV=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/sahay-pay.db');console.log(d.prepare('SELECT private_proof_url AS v FROM bills WHERE id=?').get('$BILL_ID').v);")
if [ "$DBV" = "/api/uploads/private/test-proof.pdf" ]; then echo "PASS: privateProofUrl persisted in DB"; pass=$((pass+1)); else echo "FAIL: privateProofUrl in DB — got $DBV"; fail=$((fail+1)); fi

# --- verification request linked to the bill ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/verification" $J -d "{\"type\":\"name\",\"billId\":\"$BILL_ID\"}"); t "verification request (name)" 201 "$(code "$r")"
VERIF_ID=$(echo "$(body "$r")" | jget "['verification']['id']")

# --- profile prefs + country change persist ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/profile/me" $J -d '{"notifyPrefs":{"posts":false,"gifts":true,"brands":false},"showTotals":false,"anonDefault":true}'); t "PATCH prefs" 200 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/profile/me")
has "prefs notifyPrefs persisted" "$r" '"posts":false'
has "prefs showTotals persisted" "$r" '"showTotals":false'
has "prefs anonDefault persisted" "$r" '"anonDefault":true'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/profile/me" $J -d '{"country":"IN"}'); t "PATCH country IN" 200 "$(code "$r")"
has "country changed" "$(body "$r")" '"country":"IN"'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/profile/me" $J -d '{"country":"IN"}'); t "PATCH country back" 200 "$(code "$r")"
curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/profile/me" $J -d '{"country":"NP"}' >/dev/null

# --- admin fees: full feeConfig shape + founderTipConfig round-trip ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/fees" $J -d '{"feeConfig":{"NPR":{"flatMinor":20000,"thresholdMinor":200000,"percent":12,"minMinor":20000},"INR":{"flatMinor":10000,"thresholdMinor":100000,"percent":10,"minMinor":10000}}}'); t "PUT fees feeConfig" 200 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/fees")
has "feeConfig NPR flat persisted" "$r" '"flatMinor":20000'
has "feeConfig NPR percent persisted" "$r" '"percent":12'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/fees" $J -d '{"founderTipConfig":{"enabled":true,"optionsPercent":[0,5,10],"defaultPercent":0}}'); t "PUT fees founderTipConfig" 200 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/fees")
has "founderTipConfig persisted" "$r" '"optionsPercent":[0,5,10]'
# restore defaults so later runs start clean
curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/fees" $J -d '{"feeConfig":{"NPR":{"flatMinor":16000,"thresholdMinor":160000,"percent":10,"minMinor":16000},"INR":{"flatMinor":10000,"thresholdMinor":100000,"percent":10,"minMinor":10000}}}' >/dev/null

# --- admin methods: read + toggle round-trip ---
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/methods")
has "methods has paymentMethods NP" "$r" '"NP"'
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/methods" $J -d '{"paymentMethods":{"NP":[{"id":"esewa","name":"eSewa","enabled":false}],"IN":[]}}'); t "PUT methods toggle" 200 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/methods")
has "methods toggle persisted" "$r" '"enabled":false'

# --- notification links are hash routes, not API URLs ---
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/notifications")
has "notification link is a hash route" "$r" '#/bill/'
if echo "$r" | grep -q '"/api/'; then echo "FAIL: notification still contains an /api/ link"; fail=$((fail+1)); else echo "PASS: no /api/ links in notifications"; pass=$((pass+1)); fi

# --- brand connect: workEmail required for paid plans, gmail rejected ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/brands" $J -d '{"name":"Test Bakery","story":"A local bakery that would love to support community bills with bread.","country":"NP","city":"Bhairahawa","contentNoFee":true}'); t "create brand ask (contentNoFee bool)" 201 "$(code "$r")"
BRAND_ID=$(echo "$(body "$r")" | jget "['brand']['id']")
has "contentNoFee true stored" "$(body "$r")" '"contentNoFee":true'
QUEUE=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/queue?status=pending")
BPID=$(echo "$QUEUE" | python3 -c "import sys,json;ps=json.load(sys.stdin)['packets'];print([p['id'] for p in ps if p['targetType']=='brand'][0])")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/review/$BPID" $J -d '{"decision":"approve"}'); t "approve brand ask" 200 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/brands/$BRAND_ID/connect" $J -d '{"brandName":"Test Bakery Ltd","contactName":"Ramesh","phone":"9841000000","plan":"plus","workEmail":"hello@testbakery.com"}'); t "brand connect plus + company email" 201 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/brands/$BRAND_ID/connect" $J -d '{"brandName":"Test Bakery Ltd","contactName":"Ramesh","phone":"9841000000","plan":"plus","workEmail":"someone@gmail.com"}'); t "brand connect plus + gmail -> 400" 400 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/brands/$BRAND_ID/connect" $J -d '{"brandName":"Test Bakery Ltd","contactName":"Ramesh","phone":"9841000000","plan":"free"}'); t "brand connect free, no email" 201 "$(code "$r")"
r=$(curl -s "$B/brands?brand=Bakery"); has "brand search by brand param" "$r" 'Test Bakery'

# --- cookie flags: Secure follows the request scheme (trust proxy on) ---
r=$(curl -s -D - -o /dev/null -X POST "$B/auth/onboard" $J -d '{"displayName":"Cookie Plain","age":22,"country":"NP","city":"Pokhara","termsAccepted":true,"privacyAccepted":true}')
SC=$(echo "$r" | grep -i '^set-cookie: sp_session=')
has "session cookie HttpOnly (http)" "$SC" 'HttpOnly'
has "session cookie SameSite=Lax (http)" "$SC" 'SameSite=Lax'
if echo "$SC" | grep -q 'Secure'; then echo "FAIL: session cookie Secure over plain http"; fail=$((fail+1)); else echo "PASS: session cookie not Secure over plain http"; pass=$((pass+1)); fi
r=$(curl -s -D - -o /dev/null -H 'X-Forwarded-Proto: https' -X POST "$B/auth/onboard" $J -d '{"displayName":"Cookie TLS","age":22,"country":"NP","city":"Pokhara","termsAccepted":true,"privacyAccepted":true}')
SC=$(echo "$r" | grep -i '^set-cookie: sp_session=')
has "session cookie Secure behind https proxy" "$SC" 'Secure'

# --- IDOR (item 145): user B must not reach user A's bill / payout / gift / verification / private file ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Pending IDOR bill","category":"Rent","amountMinor":150000,"story":"A pending bill for the IDOR checks.","payoutMethods":[{"method":"esewa","holderName":"Asha Sharma","account":"9845671234"}],"submit":true}'); t "create pending IDOR bill" 201 "$(code "$r")"
IDOR_BILL=$(echo "$(body "$r")" | jget "['bill']['id']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/bills/$IDOR_BILL"); t "B GET A pending bill -> 404" 404 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X PATCH "$B/bills/$IDOR_BILL" $J -d '{"title":"Hijacked title"}'); t "B PATCH A bill -> 404" 404 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/bills/$IDOR_BILL/payout" $J -d '{"payoutMethods":[{"method":"esewa","holderName":"Bikash Rai","account":"9841000000"}]}'); t "B POST payout on A bill -> 404" 404 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" -X POST "$B/bills/$IDOR_BILL/submit" $J -d '{}'); t "B POST submit on A bill -> 404" 404 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/gifts/$GIFT_ID/reveal"); t "recipient reveal of helper gift -> 404" 404 "$(code "$r")"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/admin/metrics"); t "B GET admin metrics -> 401" 401 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/verification/mine")
if echo "$r" | grep -q "$VERIF_ID"; then echo "FAIL: B verification/mine leaks A verification"; fail=$((fail+1)); else echo "PASS: B verification/mine has no A verification"; pass=$((pass+1)); fi
# private file: poster uploads a real private proof; helper must 404, poster 200
python3 -c "open('$TMPD/idor.png','wb').write(bytes.fromhex('89504e470d0a1a0a')+b'\x00'*20)"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -F "file=@$TMPD/idor.png;type=image/png" -F "kind=private_proof" "$B/uploads"); t "upload private proof" 201 "$(code "$r")"
IDOR_DOC=$(echo "$(body "$r")" | jget "['url']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/bills/$IDOR_BILL" $J -d "{\"privateProofUrl\":\"$IDOR_DOC\"}"); t "link private proof to bill" 200 "$(code "$r")"
r=$(curl -s -b "$TMPD/c-helper.txt" -H "X-CSRF-Token: $T_HELPER" "$B/uploads/private/$(basename "$IDOR_DOC")" -o /dev/null -w '%{http_code}')
t "B GET A private file -> 404" 404 "$r"
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/uploads/private/$(basename "$IDOR_DOC")" -o /dev/null -w '%{http_code}')
t "A GET own private file -> 200" 200 "$r"


echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
