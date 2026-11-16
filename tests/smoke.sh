#!/bin/bash
# Sahay Pay — backend smoke tests (curl).
# Usage: start the server first on a FRESH database, e.g.
#   rm -f data/sahay-pay.db*
#   PORT=3101 SESSION_SECRET=<random> PAYOUT_ENCRYPTION_KEY=<base64-32-bytes> \
#     CLAUDE_APPROVAL_BRIDGE_SECRET=<random> node server/index.js
# then:  BASE=http://localhost:3101 ./tests/smoke.sh
# The bridge secret used below must match the server's env (default test-bridge-secret).
# Exits non-zero if any check fails. All data created here is test data in the
# local test database only — never in the shipped database.

B="${BASE:-http://localhost:3101}/api"
BRIDGE_SECRET="${BRIDGE_SECRET:-test-bridge-secret}"
J='-H Content-Type:application/json'
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; pass=$((pass+1)); else echo "FAIL: $1 — expected $2, got $3"; fail=$((fail+1)); fi; }
code() { echo "$1" | tail -1; }
body() { echo "$1" | sed '$d'; }
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# --- config ---
r=$(curl -s -w '\n%{http_code}' "$B/config"); c=$(code "$r")
t "GET /api/config" 200 "$c"
echo "$(body "$r")" | grep -q '"feeMode":"supporter_fee"' && { echo "PASS: feeMode supporter_fee ACTIVE"; pass=$((pass+1)); } || { echo "FAIL: feeMode"; fail=$((fail+1)); }

# --- age gate ---
r=$(curl -s -w '\n%{http_code}' -X POST "$B/auth/onboard" $J -d '{"displayName":"Kid","age":17,"country":"NP","city":"Bhairahawa"}'); c=$(code "$r")
t "onboard age 17 -> 403 AGE_BLOCK" 403 "$c"
echo "$(body "$r")" | grep -q AGE_BLOCK && { echo "PASS: AGE_BLOCK code"; pass=$((pass+1)); } || { echo "FAIL: AGE_BLOCK code"; fail=$((fail+1)); }

# --- onboarding + sessions ---
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-poster.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Test Poster","age":25,"country":"NP","city":"Bhairahawa"}'); c=$(code "$r")
t "onboard poster age 25" 201 "$c"
grep -q sp_session "$TMPD/c-poster.txt" && { echo "PASS: sp_session cookie"; pass=$((pass+1)); } || { echo "FAIL: sp_session cookie"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-supporter.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Test Helper","age":30,"country":"NP","city":"Kathmandu"}'); c=$(code "$r")
t "onboard supporter age 30" 201 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-reporter.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Reporter Raj","age":28,"country":"IN","city":"Delhi"}'); c=$(code "$r")
t "onboard reporter (IN)" 201 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" "$B/auth/me"); c=$(code "$r")
t "GET /api/auth/me with cookie" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/auth/me"); c=$(code "$r")
t "GET /api/auth/me without cookie -> 200 null" 200 "$c"
echo "$(body "$r")" | grep -q '"user":null' && { echo "PASS: me null when logged out"; pass=$((pass+1)); } || { echo "FAIL: me null"; fail=$((fail+1)); }

# --- admin PIN: fail-closed, setup once, login ---
r=$(curl -s -w '\n%{http_code}' "$B/admin/pin-status")
echo "$(body "$r")" | grep -q '"pinSet":false' && { echo "PASS: pinSet false"; pass=$((pass+1)); } || { echo "FAIL: pinSet false"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/login" $J -d '{"pin":"123456"}'); c=$(code "$r")
t "admin login before setup -> 403 PIN_NOT_SET" 403 "$c"
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/setup-pin" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "setup-pin" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/setup-pin" $J -d '{"pin":"other-pin-99999"}'); c=$(code "$r")
t "second setup-pin -> 409" 409 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"wrongpin"}'); c=$(code "$r")
t "admin login wrong PIN -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "admin login correct PIN" 200 "$c"

# --- payout validation ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"12345"}]}'); c=$(code "$r")
t "bad eSewa number -> 400" 400 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -X POST "$B/bills" $J -d '{"title":"School fees help","category":"Education","story":"Need help with my child school fees this term please.","amountMinor":200000,"submit":true,"payoutMethods":[{"method":"upi","holderName":"Reporter Raj","account":"not-a-vpa"}]}'); c=$(code "$r")
t "bad UPI ID -> 400" 400 "$c"

# --- bill submit -> pending, invisible; approve -> visible ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"9845671234"}]}'); c=$(code "$r")
t "bill submit valid eSewa" 201 "$c"
BILL_ID=$(body "$r" | jget "['bill']['id']")
PACKET_ID=$(body "$r" | jget "['reviewPacketId']")
echo "$(body "$r")" | grep -q 'pending_review' && { echo "PASS: status pending_review"; pass=$((pass+1)); } || { echo "FAIL: pending_review"; fail=$((fail+1)); }
echo "$(body "$r")" | grep -q '····1234' && { echo "PASS: masked hint last-4"; pass=$((pass+1)); } || { echo "FAIL: masked hint"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" "$B/feed")
echo "$r" | grep -q '"total":0' && { echo "PASS: feed empty while pending"; pass=$((pass+1)); } || { echo "FAIL: feed not empty"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail non-owner -> 404" 404 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail owner -> 200" 200 "$c"
r=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/queue?status=pending")
echo "$r" | grep -q "$PACKET_ID" && { echo "PASS: packet in admin queue"; pass=$((pass+1)); } || { echo "FAIL: packet in queue"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -X POST "$B/admin/review/$PACKET_ID" $J -d '{"decision":"approve"}'); c=$(code "$r")
t "admin approve" 200 "$c"
r=$(curl -s -b "$TMPD/c-supporter.txt" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "PASS: approved bill in feed"; pass=$((pass+1)); } || { echo "FAIL: approved bill in feed"; fail=$((fail+1)); }

# --- bridge approve (India bill) ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -X POST "$B/bills" $J -d '{"title":"School fees help","category":"Education","story":"Need help with my child school fees this term please.","amountMinor":200000,"submit":true,"payoutMethods":[{"method":"upi","holderName":"Reporter Raj","account":"raj@okhdfc"}]}'); c=$(code "$r")
t "IN bill with valid UPI" 201 "$c"
IN_PACKET=$(body "$r" | jget "['reviewPacketId']")
r=$(curl -s -w '\n%{http_code}' -X POST "$B/bridge/approve" -H 'X-Sahay-Bridge-Secret: wrong' $J -d "{\"packetId\":\"$IN_PACKET\",\"decision\":\"approve\"}"); c=$(code "$r")
t "bridge wrong secret -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -X POST "$B/bridge/approve" -H "X-Sahay-Bridge-Secret: $BRIDGE_SECRET" $J -d "{\"packetId\":\"$IN_PACKET\",\"decision\":\"approve\"}"); c=$(code "$r")
t "bridge approve -> 200" 200 "$c"

# --- fee engine ---
r=$(curl -s -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}")
echo "$r" | grep -q '"feeMinor":16000' && { echo "PASS: NPR 1000 fee 160 flat"; pass=$((pass+1)); } || { echo "FAIL: NPR flat fee: $r"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":200000}")
echo "$r" | grep -q '"feeMinor":20000' && { echo "PASS: NPR 2000 fee 10%"; pass=$((pass+1)); } || { echo "FAIL: NPR 10% fee: $r"; fail=$((fail+1)); }

# --- gift journey: create -> reveal -> reported-sent -> confirm ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); c=$(code "$r")
t "gift create" 201 "$c"
GIFT_ID=$(body "$r" | jget "['gift']['id']")
r=$(curl -s -b "$TMPD/c-poster.txt" "$B/bills/$BILL_ID")
echo "$r" | grep -q '"coveredMinor":0' && { echo "PASS: covered 0 before confirm"; pass=$((pass+1)); } || { echo "FAIL: covered before confirm"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/$GIFT_ID/reveal" $J -d '{}'); c=$(code "$r")
t "gift reveal" 200 "$c"
echo "$(body "$r")" | grep -q '9845671234' && { echo "PASS: reveal shows real account"; pass=$((pass+1)); } || { echo "FAIL: reveal account"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/$GIFT_ID/reported-sent" $J -d '{"reference":"TXN123"}'); c=$(code "$r")
t "gift reported-sent" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/$GIFT_ID/confirm" $J -d '{}'); c=$(code "$r")
t "confirm by supporter -> 403" 403 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/gifts/$GIFT_ID/confirm" $J -d '{}'); c=$(code "$r")
t "confirm by recipient" 200 "$c"
r=$(curl -s -b "$TMPD/c-poster.txt" "$B/bills/$BILL_ID")
echo "$r" | grep -q '"coveredMinor":100000' && { echo "PASS: covered 100000 after confirm"; pass=$((pass+1)); } || { echo "FAIL: covered after confirm"; fail=$((fail+1)); }
r=$(curl -s "$B/leaders?tab=top_supporters&period=all")
echo "$r" | grep -q 'Test Helper' && { echo "PASS: supporter on leaderboard"; pass=$((pass+1)); } || { echo "FAIL: leaderboard"; fail=$((fail+1)); }
echo "$r" | grep -q '"totalMinor":100000' && { echo "PASS: leaderboard total 100000"; pass=$((pass+1)); } || { echo "FAIL: leaderboard total"; fail=$((fail+1)); }

# --- material edit -> back to review; re-approve ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X PATCH "$B/bills/$BILL_ID" $J -d '{"title":"Electricity bill help (updated)"}'); c=$(code "$r")
t "material edit" 200 "$c"
echo "$(body "$r")" | grep -q '"backToReview":true' && { echo "PASS: backToReview"; pass=$((pass+1)); } || { echo "FAIL: backToReview"; fail=$((fail+1)); }
EDIT_PACKET=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/queue?status=pending" | python3 -c "import sys,json; d=json.load(sys.stdin); print([p['id'] for p in d['packets'] if p['targetId']=='$BILL_ID'][0])")
curl -s -b "$TMPD/c-admin.txt" -X POST "$B/admin/review/$EDIT_PACKET" $J -d '{"decision":"approve"}' > /dev/null
r=$(curl -s -b "$TMPD/c-supporter.txt" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "PASS: re-approved bill back in feed"; pass=$((pass+1)); } || { echo "FAIL: re-approved in feed"; fail=$((fail+1)); }

# --- report -> auto-pause (fraud) / no pause (other); admin restore ---
r=$(curl -s -b "$TMPD/c-reporter.txt" -X POST "$B/reports" $J -d "{\"targetType\":\"bill\",\"targetId\":\"$BILL_ID\",\"reason\":\"offensive\",\"note\":\"test\"}")
echo "$r" | grep -q '"paused":false' && { echo "PASS: non-fraud report no pause"; pass=$((pass+1)); } || { echo "FAIL: non-fraud pause: $r"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -X POST "$B/reports" $J -d "{\"targetType\":\"bill\",\"targetId\":\"$BILL_ID\",\"reason\":\"scam\",\"note\":\"looks fake\"}"); c=$(code "$r")
t "fraud report" 201 "$c"
echo "$(body "$r")" | grep -q '"paused":true' && { echo "PASS: fraud report pauses"; pass=$((pass+1)); } || { echo "FAIL: fraud pause: $(body "$r")"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "FAIL: paused bill in feed"; fail=$((fail+1)); } || { echo "PASS: paused bill hidden"; pass=$((pass+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":10000}"); c=$(code "$r")
t "gift quote on paused bill -> 409" 409 "$c"
REP_ID=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/reports?status=open" | python3 -c "import sys,json; d=json.load(sys.stdin); print([x['id'] for x in d['reports'] if x['reason']=='scam'][0])")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -X POST "$B/admin/reports/$REP_ID" $J -d '{"action":"restore"}'); c=$(code "$r")
t "admin restore paused bill" 200 "$c"

# --- fee mode switch ---
curl -s -b "$TMPD/c-admin.txt" -X PUT "$B/admin/fees" $J -d '{"feeMode":"zero_fee_plus_tip"}' > /dev/null
r=$(curl -s -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}")
echo "$r" | grep -q '"feeMinor":0' && { echo "PASS: zero-fee mode quotes 0"; pass=$((pass+1)); } || { echo "FAIL: zero-fee quote: $r"; fail=$((fail+1)); }
curl -s -b "$TMPD/c-admin.txt" -X PUT "$B/admin/fees" $J -d '{"feeMode":"supporter_fee"}' > /dev/null

# --- admin metrics + audit ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" "$B/admin/metrics"); c=$(code "$r")
t "admin metrics" 200 "$c"
r=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/audit")
echo "$r" | grep -q 'payout_revealed' && { echo "PASS: audit has payout_revealed"; pass=$((pass+1)); } || { echo "FAIL: audit payout_revealed"; fail=$((fail+1)); }
echo "$r" | grep -q 'bill_auto_paused' && { echo "PASS: audit has bill_auto_paused"; pass=$((pass+1)); } || { echo "FAIL: audit bill_auto_paused"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' "$B/admin/metrics"); c=$(code "$r")
t "admin metrics without session -> 401" 401 "$c"

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
