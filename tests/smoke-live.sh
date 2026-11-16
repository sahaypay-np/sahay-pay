#!/bin/bash
# Sahay Pay — LIVE-safe smoke tests (curl). Runs against the deployed site.
# Unlike tests/smoke.sh this NEVER touches the admin PIN (danish sets his own
# PIN first — claiming it here would lock him out), never flips the fee mode,
# and never uses the approval bridge (unset on live). Admin-gated journeys
# (approve -> gift -> confirm, reports, fee switch) are covered by the local
# suite only. Test users/bills created here are wiped afterwards with the
# SQL in tests/live-wipe.sql (run in Supabase).
# Usage: BASE=https://sahay-pay.netlify.app ./tests/smoke-live.sh

B="${BASE:-https://sahay-pay.netlify.app}/api"
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

# --- admin PIN status: READ-ONLY. Never set it here. ---
r=$(curl -s -w '\n%{http_code}' "$B/admin/pin-status"); c=$(code "$r")
t "GET /api/admin/pin-status" 200 "$c"
PINSET=$(body "$r" | grep -o '"pinSet":[a-z]*' | cut -d: -f2)
if [ "$PINSET" = "false" ]; then
  echo "PASS: pinSet false (danish can still set his own PIN)"; pass=$((pass+1))
  r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/login" $J -d '{"pin":"123456"}'); c=$(code "$r")
  t "admin login before setup -> 403 PIN_NOT_SET" 403 "$c"
elif [ "$PINSET" = "true" ]; then
  echo "PASS: pinSet true (danish already set his PIN)"; pass=$((pass+1))
  r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/login" $J -d '{"pin":"wrongpin-000"}'); c=$(code "$r")
  t "admin login wrong PIN -> 401" 401 "$c"
else
  echo "FAIL: pinSet unreadable: $(body "$r")"; fail=$((fail+1))
fi

# --- payout validation (no data created) ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"12345"}]}'); c=$(code "$r")
t "bad eSewa number -> 400" 400 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -X POST "$B/bills" $J -d '{"title":"School fees help","category":"Education","story":"Need help with my child school fees this term please.","amountMinor":200000,"submit":true,"payoutMethods":[{"method":"upi","holderName":"Reporter Raj","account":"not-a-vpa"}]}'); c=$(code "$r")
t "bad UPI ID -> 400" 400 "$c"

# --- bill submit -> pending, invisible ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"9845671234"}]}'); c=$(code "$r")
t "bill submit valid eSewa" 201 "$c"
BILL_ID=$(body "$r" | jget "['bill']['id']")
echo "$(body "$r")" | grep -q 'pending_review' && { echo "PASS: status pending_review"; pass=$((pass+1)); } || { echo "FAIL: pending_review"; fail=$((fail+1)); }
echo "$(body "$r")" | grep -q '····1234' && { echo "PASS: masked hint last-4"; pass=$((pass+1)); } || { echo "FAIL: masked hint"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "FAIL: pending bill in feed"; fail=$((fail+1)); } || { echo "PASS: pending bill not in feed"; pass=$((pass+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail non-owner -> 404" 404 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail owner -> 200" 200 "$c"

# --- gift guards: nothing payable before approval ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); c=$(code "$r")
t "gift quote on pending bill -> 409" 409 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); c=$(code "$r")
t "gift create on pending bill -> 409" 409 "$c"

# --- upload: multipart through the real Netlify function + byte-identical download ---
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | python3 -c "import sys,base64;sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))" > "$TMPD/dot.png"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/uploads" -F "kind=public_bill" -F "file=@$TMPD/dot.png;type=image/png"); c=$(code "$r")
t "upload PNG" 201 "$c"
FILE_URL=$(body "$r" | jget "['url']")
curl -s "https://sahay-pay.netlify.app$FILE_URL" -o "$TMPD/dot-back.png"
cmp -s "$TMPD/dot.png" "$TMPD/dot-back.png" && { echo "PASS: download bytes match upload"; pass=$((pass+1)); } || { echo "FAIL: download bytes differ"; fail=$((fail+1)); }

# --- owner removes the test bill (soft delete; the SQL wipe removes the rest) ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -X POST "$B/bills/$BILL_ID/remove" $J -d '{}'); c=$(code "$r")
t "owner removes test bill" 200 "$c"

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
