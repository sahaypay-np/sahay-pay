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
r=$(curl -s -w '\n%{http_code}' "$B/stats"); c=$(code "$r")
t "GET /api/stats" 200 "$c"
echo "$(body "$r")" | grep -q 'giftsConfirmed' && { echo "PASS: stats has giftsConfirmed"; pass=$((pass+1)); } || { echo "FAIL: stats shape"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' "$B/changelog"); c=$(code "$r")
t "GET /api/changelog" 200 "$c"

# --- age gate ---
r=$(curl -s -w '\n%{http_code}' -X POST "$B/auth/onboard" $J -d '{"displayName":"Kid","age":17,"country":"NP","city":"Bhairahawa","termsAccepted":true,"privacyAccepted":true}'); c=$(code "$r")
t "onboard age 17 -> 403 AGE_BLOCK" 403 "$c"
echo "$(body "$r")" | grep -q AGE_BLOCK && { echo "PASS: AGE_BLOCK code"; pass=$((pass+1)); } || { echo "FAIL: AGE_BLOCK code"; fail=$((fail+1)); }

# --- onboarding + sessions ---
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-poster.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Test Poster","age":25,"country":"NP","city":"Bhairahawa","termsAccepted":true,"privacyAccepted":true}'); c=$(code "$r")
t "onboard poster age 25" 201 "$c"
T_POSTER=$(curl -s -b "$TMPD/c-poster.txt" "$B/auth/csrf" | jget "['csrfToken']")
# --- recovery code: issued once at onboarding, hash-only storage ---
RC_POSTER=$(body "$r" | jget "['recoveryCode']")
echo "$RC_POSTER" | grep -qE '^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$' && { echo "PASS: recovery code format XXXX-XXXX-XXXX-XXXX"; pass=$((pass+1)); } || { echo "FAIL: recovery code format: $RC_POSTER"; fail=$((fail+1)); }
echo "$(body "$r")" | grep -q '"consentCurrent":true' && { echo "PASS: consentCurrent true at onboarding"; pass=$((pass+1)); } || { echo "FAIL: consentCurrent"; fail=$((fail+1)); }
DBRC=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/sahay-pay.db');const r=d.prepare('SELECT recovery_code_hash AS h, recovery_code_lookup AS l FROM users WHERE username LIKE \'testposter%\'').get();console.log(JSON.stringify(r));")
echo "$DBRC" | grep -q '"h":null' && { echo "FAIL: recovery hash missing"; fail=$((fail+1)); } || { echo "PASS: recovery hash stored"; pass=$((pass+1)); }
echo "$DBRC" | grep -q "${RC_POSTER//-/}" && { echo "FAIL: plain recovery code found in DB"; fail=$((fail+1)); } || { echo "PASS: plain recovery code absent from DB"; pass=$((pass+1)); }
# --- onboard without consent flags -> 400 ---
r=$(curl -s -w '\n%{http_code}' -X POST "$B/auth/onboard" $J -d '{"displayName":"No Consent","age":25,"country":"NP","city":"Bhairahawa"}'); c=$(code "$r")
t "onboard without consent -> 400" 400 "$c"
grep -q sp_session "$TMPD/c-poster.txt" && { echo "PASS: sp_session cookie"; pass=$((pass+1)); } || { echo "FAIL: sp_session cookie"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-supporter.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Test Helper","age":30,"country":"NP","city":"Kathmandu","termsAccepted":true,"privacyAccepted":true}'); c=$(code "$r")
t "onboard supporter age 30" 201 "$c"
T_SUPPORTER=$(curl -s -b "$TMPD/c-supporter.txt" "$B/auth/csrf" | jget "['csrfToken']")
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-reporter.txt" -X POST "$B/auth/onboard" $J -d '{"displayName":"Reporter Raj","age":28,"country":"IN","city":"Delhi","termsAccepted":true,"privacyAccepted":true}'); c=$(code "$r")
t "onboard reporter (IN)" 201 "$c"
T_REPORTER=$(curl -s -b "$TMPD/c-reporter.txt" "$B/auth/csrf" | jget "['csrfToken']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/auth/me"); c=$(code "$r")
t "GET /api/auth/me with cookie" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/auth/me"); c=$(code "$r")
t "GET /api/auth/me without cookie -> 200 null" 200 "$c"
echo "$(body "$r")" | grep -q '"user":null' && { echo "PASS: me null when logged out"; pass=$((pass+1)); } || { echo "FAIL: me null"; fail=$((fail+1)); }

# --- recovery: wrong code rejected, right code restores the session ---
r=$(curl -s -w '\n%{http_code}' -X POST "$B/auth/recover" $J -d '{"code":"AAAA-AAAA-AAAA-AAAA"}'); c=$(code "$r")
t "recover wrong code -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-recovered.txt" -X POST "$B/auth/recover" $J -d "{\"code\":\"$RC_POSTER\"}"); c=$(code "$r")
t "recover right code -> 200" 200 "$c"
echo "$(body "$r")" | grep -q 'Test Poster' && { echo "PASS: recovery restores poster session"; pass=$((pass+1)); } || { echo "FAIL: recovery user"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-recovered.txt" -H "X-CSRF-Token: $T_POSTER" "$B/auth/me")
echo "$r" | grep -q "$RC_POSTER" && { echo "FAIL: recovery code re-shown in /me"; fail=$((fail+1)); } || { echo "PASS: code never re-shown in /me"; pass=$((pass+1)); }
r=$(curl -s -b "$TMPD/c-recovered.txt" -H "X-CSRF-Token: $T_POSTER" "$B/profile/me")
echo "$r" | grep -q "$RC_POSTER" && { echo "FAIL: recovery code re-shown in /profile/me"; fail=$((fail+1)); } || { echo "PASS: code never re-shown in /profile/me"; pass=$((pass+1)); }

# --- admin PIN: fail-closed, setup once, login ---
r=$(curl -s -w '\n%{http_code}' "$B/admin/pin-status")
echo "$(body "$r")" | grep -q '"pinSet":false' && { echo "PASS: pinSet false"; pass=$((pass+1)); } || { echo "FAIL: pinSet false"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/login" $J -d '{"pin":"123456"}'); c=$(code "$r")
t "admin login before setup -> 403 PIN_NOT_SET" 403 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/admin/session"); c=$(code "$r")
t "GET /admin/session logged out -> 200 (no 401 console error)" 200 "$c"
echo "$(body "$r")" | grep -q '"admin":false' && { echo "PASS: session admin false logged out"; pass=$((pass+1)); } || { echo "FAIL: session admin false"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/setup-pin" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "setup-pin" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -X POST "$B/admin/setup-pin" $J -d '{"pin":"other-pin-99999"}'); c=$(code "$r")
t "second setup-pin -> 409" 409 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"wrongpin"}'); c=$(code "$r")
t "admin login wrong PIN -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "admin login correct PIN" 200 "$c"
r=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/session")
echo "$r" | grep -q '"admin":true' && { echo "PASS: session admin true after login"; pass=$((pass+1)); } || { echo "FAIL: session admin true"; fail=$((fail+1)); }
T_ADMIN=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/csrf" | jget "['csrfToken']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/elevate" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "admin elevate" 200 "$c"

# --- payout validation ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutConsent":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"12345"}]}'); c=$(code "$r")
t "bad eSewa number -> 400" 400 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -H "X-CSRF-Token: $T_REPORTER" -X POST "$B/bills" $J -d '{"title":"School fees help","category":"Education","story":"Need help with my child school fees this term please.","amountMinor":200000,"submit":true,"payoutConsent":true,"payoutMethods":[{"method":"upi","holderName":"Reporter Raj","account":"not-a-vpa"}]}'); c=$(code "$r")
t "bad UPI ID -> 400" 400 "$c"

# --- bill submit -> pending, invisible; approve -> visible ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/bills" $J -d '{"title":"Electricity bill help","category":"Electricity","story":"My electricity bill is due and I need help paying it this month.","amountMinor":500000,"submit":true,"payoutConsent":true,"payoutMethods":[{"method":"esewa","holderName":"Test Poster","account":"9845671234"}]}'); c=$(code "$r")
t "bill submit valid eSewa" 201 "$c"
BILL_ID=$(body "$r" | jget "['bill']['id']")
PACKET_ID=$(body "$r" | jget "['reviewPacketId']")
echo "$(body "$r")" | grep -q 'pending_review' && { echo "PASS: status pending_review"; pass=$((pass+1)); } || { echo "FAIL: pending_review"; fail=$((fail+1)); }
echo "$(body "$r")" | grep -q '····1234' && { echo "PASS: masked hint last-4"; pass=$((pass+1)); } || { echo "FAIL: masked hint"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/feed")
echo "$r" | grep -q '"total":0' && { echo "PASS: feed empty while pending"; pass=$((pass+1)); } || { echo "FAIL: feed not empty"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail non-owner -> 404" 404 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/bills/$BILL_ID"); c=$(code "$r")
t "pending bill detail owner -> 200" 200 "$c"
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/queue?status=pending")
echo "$r" | grep -q "$PACKET_ID" && { echo "PASS: packet in admin queue"; pass=$((pass+1)); } || { echo "FAIL: packet in queue"; fail=$((fail+1)); }
echo "$r" | grep -q '9845671234' && { echo "FAIL: admin queue leaks payout plaintext (835)"; fail=$((fail+1)); } || { echo "PASS: admin queue has no payout plaintext (835)"; pass=$((pass+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/review/$PACKET_ID" $J -d '{"decision":"approve"}'); c=$(code "$r")
t "admin approve" 200 "$c"

# --- admin export: admin-only, full data, no secrets, payout stays encrypted ---
r=$(curl -s -w '\n%{http_code}' "$B/admin/export"); c=$(code "$r")
t "GET /admin/export anonymous -> 401" 401 "$c"
curl -s -b "$TMPD/c-admin.txt" "$B/admin/export" > "$TMPD/export.json"
python3 -c "import json; d=json.load(open('$TMPD/export.json')); t=d['tables']; assert 'users' in t and 'bills' in t and 'payout_methods' in t and 'gifts' in t and 'settings' in t and 'audit_logs' in t, 'missing tables'; assert len(t['users'])>=1 and len(t['bills'])>=1 and len(t['payout_methods'])>=1, 'empty tables'; assert all('account_enc' in p for p in t['payout_methods']), 'no account_enc'; assert all(s.get('key') != 'admin_pin_hash' for s in t['settings']), 'admin_pin_hash in settings'; assert all('recovery_code_hash' not in u and 'recovery_code_lookup' not in u for u in t['users']), 'recovery hashes in users'" && { echo "PASS: export parses with expected tables + encrypted payout + no secret keys"; pass=$((pass+1)); } || { echo "FAIL: export shape"; fail=$((fail+1)); }
# Plaintext secrets must not appear anywhere in the file (the audit log legitimately
# names 'admin_pin_hash' as the target of the PIN-setup action — that string is metadata,
# not the hash, so it is asserted structurally above, not by raw grep).
for bad in 9845671234 smoke-pin-12345; do
  grep -q "$bad" "$TMPD/export.json" && { echo "FAIL: export leaks $bad"; fail=$((fail+1)); } || { echo "PASS: export has no $bad"; pass=$((pass+1)); }
done
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "PASS: approved bill in feed"; pass=$((pass+1)); } || { echo "FAIL: approved bill in feed"; fail=$((fail+1)); }
echo "$r" | grep -q '9845671234' && { echo "FAIL: feed leaks payout plaintext (835)"; fail=$((fail+1)); } || { echo "PASS: feed has no payout plaintext (835)"; pass=$((pass+1)); }

# --- bridge approve (India bill) ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -H "X-CSRF-Token: $T_REPORTER" -X POST "$B/bills" $J -d '{"title":"School fees help","category":"Education","story":"Need help with my child school fees this term please.","amountMinor":200000,"submit":true,"payoutConsent":true,"payoutMethods":[{"method":"upi","holderName":"Reporter Raj","account":"raj@okhdfc"}]}'); c=$(code "$r")
t "IN bill with valid UPI" 201 "$c"
IN_PACKET=$(body "$r" | jget "['reviewPacketId']")
r=$(curl -s -w '\n%{http_code}' -X POST "$B/bridge/approve" -H 'X-Sahay-Bridge-Secret: wrong' $J -d "{\"packetId\":\"$IN_PACKET\",\"decision\":\"approve\"}"); c=$(code "$r")
t "bridge wrong secret -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -X POST "$B/bridge/approve" -H "X-Sahay-Bridge-Secret: $BRIDGE_SECRET" $J -d "{\"packetId\":\"$IN_PACKET\",\"decision\":\"approve\"}"); c=$(code "$r")
t "bridge approve -> 200" 200 "$c"

# --- fee engine ---
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}")
echo "$r" | grep -q '"feeMinor":16000' && { echo "PASS: NPR 1000 fee 160 flat"; pass=$((pass+1)); } || { echo "FAIL: NPR flat fee: $r"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":200000}")
echo "$r" | grep -q '"feeMinor":20000' && { echo "PASS: NPR 2000 fee 10%"; pass=$((pass+1)); } || { echo "FAIL: NPR 10% fee: $r"; fail=$((fail+1)); }

# --- gift journey: create -> reveal -> reported-sent -> confirm ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}"); c=$(code "$r")
t "gift create" 201 "$c"
GIFT_ID=$(body "$r" | jget "['gift']['id']")
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/bills/$BILL_ID")
echo "$r" | grep -q '"coveredMinor":0' && { echo "PASS: covered 0 before confirm"; pass=$((pass+1)); } || { echo "FAIL: covered before confirm"; fail=$((fail+1)); }
# Phase 2 (824/847): reveal needs a session aged 5+ min + a solved challenge.
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/sahay-pay.db');d.prepare('UPDATE sessions SET created_at=? WHERE user_id=(SELECT id FROM users WHERE username LIKE \'testhelper%\')').run(new Date(Date.now()-6*60*1000).toISOString());"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/$GIFT_ID/reveal" $J -d '{}'); c=$(code "$r")
t "reveal without challenge -> 400" 400 "$c"
CH=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/gifts/$GIFT_ID/challenge")
CID=$(echo "$CH" | jget "['challengeId']")
ANS=$(echo "$CH" | python3 -c "import sys,json,re; q=json.load(sys.stdin)['question']; a,b=re.search(r'(\d+) \+ (\d+)',q).groups(); print(int(a)+int(b))")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -c "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/$GIFT_ID/reveal" $J -d "{\"challengeId\":\"$CID\",\"answer\":$ANS}"); c=$(code "$r")
t "gift reveal" 200 "$c"
echo "$(body "$r")" | grep -q '9845671234' && { echo "PASS: reveal shows real account"; pass=$((pass+1)); } || { echo "FAIL: reveal account"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/gifts/$GIFT_ID"); c=$(code "$r")
t "gift receipt (party)" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/auth/security-activity"); c=$(code "$r")
t "security activity" 200 "$c"
echo "$(body "$r")" | grep -q 'payout_revealed' && { echo "PASS: security activity has payout_revealed"; pass=$((pass+1)); } || { echo "FAIL: security activity payout_revealed"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/$GIFT_ID/reported-sent" $J -d '{"reference":"TXN123"}'); c=$(code "$r")
t "gift reported-sent" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/$GIFT_ID/confirm" $J -d '{}'); c=$(code "$r")
t "confirm by supporter -> 403" 403 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/gifts/$GIFT_ID/confirm" $J -d '{}'); c=$(code "$r")
t "confirm by recipient" 200 "$c"
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/bills/$BILL_ID")
echo "$r" | grep -q '"coveredMinor":100000' && { echo "PASS: covered 100000 after confirm"; pass=$((pass+1)); } || { echo "FAIL: covered after confirm"; fail=$((fail+1)); }
r=$(curl -s "$B/leaders?tab=top_supporters&period=all")
echo "$r" | grep -q 'Test Helper' && { echo "PASS: supporter on leaderboard"; pass=$((pass+1)); } || { echo "FAIL: leaderboard"; fail=$((fail+1)); }
echo "$r" | grep -q '"totalMinor":100000' && { echo "PASS: leaderboard total 100000"; pass=$((pass+1)); } || { echo "FAIL: leaderboard total"; fail=$((fail+1)); }

# --- material edit -> back to review; re-approve ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/bills/$BILL_ID" $J -d '{"title":"Electricity bill help (updated)"}'); c=$(code "$r")
t "material edit" 200 "$c"
echo "$(body "$r")" | grep -q '"backToReview":true' && { echo "PASS: backToReview"; pass=$((pass+1)); } || { echo "FAIL: backToReview"; fail=$((fail+1)); }
EDIT_PACKET=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/queue?status=pending" | python3 -c "import sys,json; d=json.load(sys.stdin); print([p['id'] for p in d['packets'] if p['targetId']=='$BILL_ID'][0])")
curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/review/$EDIT_PACKET" $J -d '{"decision":"approve"}' > /dev/null
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "PASS: re-approved bill back in feed"; pass=$((pass+1)); } || { echo "FAIL: re-approved in feed"; fail=$((fail+1)); }

# --- report -> auto-pause (fraud) / no pause (other); admin restore ---
r=$(curl -s -b "$TMPD/c-reporter.txt" -H "X-CSRF-Token: $T_REPORTER" -X POST "$B/reports" $J -d "{\"targetType\":\"bill\",\"targetId\":\"$BILL_ID\",\"reason\":\"offensive\",\"note\":\"test\"}")
echo "$r" | grep -q '"paused":false' && { echo "PASS: non-fraud report no pause"; pass=$((pass+1)); } || { echo "FAIL: non-fraud pause: $r"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-reporter.txt" -H "X-CSRF-Token: $T_REPORTER" -X POST "$B/reports" $J -d "{\"targetType\":\"bill\",\"targetId\":\"$BILL_ID\",\"reason\":\"scam\",\"note\":\"looks fake\"}"); c=$(code "$r")
t "fraud report" 201 "$c"
echo "$(body "$r")" | grep -q '"paused":true' && { echo "PASS: fraud report pauses"; pass=$((pass+1)); } || { echo "FAIL: fraud pause: $(body "$r")"; fail=$((fail+1)); }
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" "$B/feed")
echo "$r" | grep -q "$BILL_ID" && { echo "FAIL: paused bill in feed"; fail=$((fail+1)); } || { echo "PASS: paused bill hidden"; pass=$((pass+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":10000}"); c=$(code "$r")
t "gift quote on paused bill -> 409" 409 "$c"
REP_ID=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/reports?status=open" | python3 -c "import sys,json; d=json.load(sys.stdin); print([x['id'] for x in d['reports'] if x['reason']=='scam'][0])")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/reports/$REP_ID" $J -d '{"action":"restore"}'); c=$(code "$r")
t "admin restore paused bill" 200 "$c"

# --- fee mode switch ---
curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/fees" $J -d '{"feeMode":"zero_fee_plus_tip"}' > /dev/null
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "X-CSRF-Token: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}")
echo "$r" | grep -q '"feeMinor":0' && { echo "PASS: zero-fee mode quotes 0"; pass=$((pass+1)); } || { echo "FAIL: zero-fee quote: $r"; fail=$((fail+1)); }
curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/fees" $J -d '{"feeMode":"supporter_fee"}' > /dev/null

# --- admin metrics + audit ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/metrics"); c=$(code "$r")
t "admin metrics" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/security"); c=$(code "$r")
t "admin security view" 200 "$c"
echo "$(body "$r")" | grep -q 'blockedReveals24h' && { echo "PASS: security view has blockedReveals24h"; pass=$((pass+1)); } || { echo "FAIL: security view shape"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/abuse"); c=$(code "$r")
t "admin abuse view" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/transparency-report" $J -d '{}'); c=$(code "$r")
t "transparency report publish" 200 "$c"
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/audit")
echo "$r" | grep -q 'payout_revealed' && { echo "PASS: audit has payout_revealed"; pass=$((pass+1)); } || { echo "FAIL: audit payout_revealed"; fail=$((fail+1)); }
echo "$r" | grep -q 'bill_auto_paused' && { echo "PASS: audit has bill_auto_paused"; pass=$((pass+1)); } || { echo "FAIL: audit bill_auto_paused"; fail=$((fail+1)); }
echo "$r" | grep -q '9845671234' && { echo "FAIL: audit log leaks payout plaintext (835)"; fail=$((fail+1)); } || { echo "PASS: audit log has no payout plaintext (835)"; pass=$((pass+1)); }
r=$(curl -s -w '\n%{http_code}' "$B/admin/metrics"); c=$(code "$r")
t "admin metrics without session -> 401" 401 "$c"

# --- CSRF: state-changing POST without a token -> 403 CSRF_INVALID ---
cp "$TMPD/c-poster.txt" "$TMPD/c-notoken.txt"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-notoken.txt" -X POST "$B/bills" $J -d '{"title":"No token bill","category":"Rent","story":"This post has no CSRF token.","amountMinor":100000,"submit":false}'); c=$(code "$r")
t "POST without CSRF token -> 403" 403 "$c"
echo "$(body "$r")" | grep -q CSRF_INVALID && { echo "PASS: CSRF_INVALID code"; pass=$((pass+1)); } || { echo "FAIL: CSRF_INVALID code"; fail=$((fail+1)); }

# --- Origin check: cross-site Origin -> 403 ORIGIN_REJECTED ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-notoken.txt" -H "Origin: https://evil.example" -X POST "$B/bills" $J -d '{"title":"Evil origin bill","category":"Rent","story":"This post comes from a bad origin.","amountMinor":100000,"submit":false}'); c=$(code "$r")
t "POST with evil Origin -> 403" 403 "$c"
echo "$(body "$r")" | grep -q ORIGIN_REJECTED && { echo "PASS: ORIGIN_REJECTED code"; pass=$((pass+1)); } || { echo "FAIL: ORIGIN_REJECTED code"; fail=$((fail+1)); }

# --- data export ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/profile/export"); c=$(code "$r")
t "GET /api/profile/export" 200 "$c"
echo "$(body "$r")" | grep -q '"profile"' && echo "$(body "$r")" | grep -q '"bills"' && echo "$(body "$r")" | grep -q '"giftsGiven"' && echo "$(body "$r")" | grep -q '"notifications"' && { echo "PASS: export has profile+bills+gifts+notifications"; pass=$((pass+1)); } || { echo "FAIL: export shape"; fail=$((fail+1)); }
echo "$(body "$r")" | grep -q 'account_enc' && { echo "FAIL: export leaks account_enc"; fail=$((fail+1)); } || { echo "PASS: export has no encrypted accounts"; pass=$((pass+1)); }

# --- honeypot on the complaint form ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/complaints" $J -d '{"subject":"Spam test","body":"This complaint filled the honeypot field.","website":"http://spam.example"}'); c=$(code "$r")
t "complaint with honeypot filled -> 400" 400 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/complaints" $J -d '{"subject":"Real complaint","body":"This is a genuine complaint with enough text."}'); c=$(code "$r")
t "complaint clean -> 201" 201 "$c"
COMPLAINT_ID=$(body "$r" | jget "['complaintId']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/complaints/$COMPLAINT_ID/status"); c=$(code "$r")
t "complaint status (owner)" 200 "$c"

# --- magic-byte upload check ---
printf 'hello this is not an image at all, just plain text..........' > "$TMPD/fake.jpg"
python3 -c "open('$TMPD/real.png','wb').write(bytes.fromhex('89504e470d0a1a0a')+b'\x00'*20)"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -F "file=@$TMPD/fake.jpg;type=image/jpeg" -F "kind=avatar" "$B/uploads"); c=$(code "$r")
t "upload fake jpg (text bytes) -> 400" 400 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -F "file=@$TMPD/real.png;type=image/png" -F "kind=id_doc" "$B/uploads"); c=$(code "$r")
t "upload real png (file-first order) -> 201" 201 "$c"
DOC_URL=$(body "$r" | jget "['url']")
DOC_FN=$(basename "$DOC_URL")
[ -f "uploads/private/$DOC_FN" ] && { echo "PASS: private upload lands in private dir"; pass=$((pass+1)); } || { echo "FAIL: private upload not in private dir ($DOC_FN)"; fail=$((fail+1)); }

# --- verification doc deletion on decision ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/verification" $J -d "{\"type\":\"id\",\"docUrl\":\"$DOC_URL\"}"); c=$(code "$r")
t "verification submit (id)" 201 "$c"
VERIF_ID=$(body "$r" | jget "['verification']['id']")
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/uploads/private/$DOC_FN" -o /dev/null -w '%{http_code}')
t "owner can fetch private doc before decision" 200 "$r"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X POST "$B/admin/verifications/$VERIF_ID" $J -d '{"decision":"approve","note":"checked"}'); c=$(code "$r")
t "admin approve verification" 200 "$c"
echo "$(body "$r")" | grep -q '"docDeleted":true' && { echo "PASS: docDeleted true"; pass=$((pass+1)); } || { echo "FAIL: docDeleted"; fail=$((fail+1)); }
[ -f "uploads/private/$DOC_FN" ] && { echo "FAIL: verification doc still on disk"; fail=$((fail+1)); } || { echo "PASS: verification doc deleted from disk"; pass=$((pass+1)); }
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/uploads/private/$DOC_FN" -o /dev/null -w '%{http_code}')
t "private doc 404 after decision" 404 "$r"

# --- sessions list + per-session revoke ---
r=$(curl -s -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" "$B/auth/sessions")
echo "$r" | grep -q '"current":true' && { echo "PASS: sessions list has current session"; pass=$((pass+1)); } || { echo "FAIL: sessions list"; fail=$((fail+1)); }
echo "$r" | grep -q 'deviceLabel' && { echo "PASS: sessions list has deviceLabel"; pass=$((pass+1)); } || { echo "FAIL: sessions deviceLabel"; fail=$((fail+1)); }
OTHER_SID=$(echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);print([s['id'] for s in d['sessions'] if not s['current']][0])")
CUR_SID=$(echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);print([s['id'] for s in d['sessions'] if s['current']][0])")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X PATCH "$B/auth/sessions/$CUR_SID/note" $J -d '{"note":"Smoke laptop"}'); c=$(code "$r")
t "session note save" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X DELETE "$B/auth/sessions/$OTHER_SID"); c=$(code "$r")
t "revoke other session" 200 "$c"
r=$(curl -s -b "$TMPD/c-recovered.txt" "$B/auth/me")
echo "$r" | grep -q '"user":null' && { echo "PASS: revoked session is logged out"; pass=$((pass+1)); } || { echo "FAIL: revoked session still valid"; fail=$((fail+1)); }

# --- re-consent endpoint ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/auth/re-consent" $J -d '{"termsAccepted":true,"privacyAccepted":true}'); c=$(code "$r")
t "POST /api/auth/re-consent" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-poster.txt" -H "X-CSRF-Token: $T_POSTER" -X POST "$B/auth/logout-others" $J -d '{}'); c=$(code "$r")
t "POST /api/auth/logout-others" 200 "$c"

# --- admin login IP is in the audit log ---
r=$(curl -s -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/audit?limit=50")
echo "$r" | grep -q 'admin_login' && echo "$r" | grep -q '"ip"' && { echo "PASS: admin login audit has IP"; pass=$((pass+1)); } || { echo "FAIL: admin login IP in audit"; fail=$((fail+1)); }

# --- admin idle timeout: backdate last_seen 31 min -> 401, then re-login works ---
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/sahay-pay.db');d.prepare('UPDATE admin_sessions SET last_seen_at=?').run(new Date(Date.now()-31*60*1000).toISOString());"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/metrics"); c=$(code "$r")
t "admin metrics after 31 min idle -> 401" 401 "$c"
r=$(curl -s -w '\n%{http_code}' -c "$TMPD/c-admin.txt" -X POST "$B/admin/login" $J -d '{"pin":"smoke-pin-12345"}'); c=$(code "$r")
t "admin re-login after idle expiry" 200 "$c"
T_ADMIN=$(curl -s -b "$TMPD/c-admin.txt" "$B/admin/csrf" | jget "['csrfToken']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/metrics"); c=$(code "$r")
t "admin metrics after re-login" 200 "$c"

# --- maintenance kill switch ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/maintenance" $J -d '{"enabled":true,"message":"Smoke-test maintenance"}'); c=$(code "$r")
t "maintenance on" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/feed"); c=$(code "$r")
t "feed during maintenance -> 503" 503 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/health"); c=$(code "$r")
t "health during maintenance -> 200" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" "$B/admin/metrics"); c=$(code "$r")
t "admin metrics during maintenance -> 200" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/maintenance" $J -d '{"enabled":false}'); c=$(code "$r")
t "maintenance off" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/feed"); c=$(code "$r")
t "feed after maintenance off -> 200" 200 "$c"

# --- emergency freeze (883): same shape as maintenance, feed + gifts only ---
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/freeze" $J -d '{"enabled":true,"message":"Smoke-test freeze"}'); c=$(code "$r")
t "freeze on" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/feed"); c=$(code "$r")
t "feed during freeze -> 503" 503 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/health"); c=$(code "$r")
t "health during freeze -> 200" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "X-CSRF-Token: $T_ADMIN" -X PUT "$B/admin/freeze" $J -d '{"enabled":false}'); c=$(code "$r")
t "freeze off" 200 "$c"
r=$(curl -s -w '\n%{http_code}' "$B/feed"); c=$(code "$r")
t "feed after freeze off -> 200" 200 "$c"
# --- Phase 2 S3: gifting, payments, fee engine ---
# NOTE: the CSRF header name is held in CSRF_H so the literal header pattern
# never appears in this block — an input-side redaction filter truncated
# lines containing it during an earlier write of this section.
CSRF_H="X-CSRF-Token"
r=$(curl -s "$B/config")
echo "$r" | grep -q '"giftAmountChips"' && echo "$r" | grep -q '"minGiftMinorNPR"' && echo "$r" | grep -q '"feeModelSentenceNPR"' && { echo "PASS: config has gift chips + min gift + fee sentences"; pass=$((pass+1)); } || { echo "FAIL: config S3 fields"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":500}"); c=$(code "$r")
t "gift quote below min -> 400" 400 "$c"
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts/quote" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":100000}")
echo "$r" | grep -q '"feeModelSentence"' && { echo "PASS: quote carries feeModelSentence"; pass=$((pass+1)); } || { echo "FAIL: quote feeModelSentence"; fail=$((fail+1)); }
# gift with message + anonymous
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":50000,\"message\":\"Hope this helps\",\"anonymous\":true}"); c=$(code "$r")
t "gift with message + anonymous" 201 "$c"
GIFT2_ID=$(body "$r" | jget "['gift']['id']")
echo "$(body "$r")" | grep -q '"message":"Hope this helps"' && { echo "PASS: gift message stored"; pass=$((pass+1)); } || { echo "FAIL: gift message"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":50000,\"message\":\"call me on 9876543210\"}"); c=$(code "$r")
t "gift with blocked message -> 400" 400 "$c"
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/gifts/bill/$BILL_ID")
echo "$r" | grep -q '"message":"Hope this helps"' && { echo "PASS: gift message on bill timeline"; pass=$((pass+1)); } || { echo "FAIL: message on bill timeline"; fail=$((fail+1)); }
# receipt for the confirmed gift (261/265)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/gifts/$GIFT_ID/receipt"); c=$(code "$r")
t "GET receipt for confirmed gift" 200 "$c"
echo "$(body "$r")" | grep -qE '"receiptNumber":"SP-R-[A-Z0-9]{6}"' && { echo "PASS: receipt number SP-R-XXXXXX"; pass=$((pass+1)); } || { echo "FAIL: receipt number format"; fail=$((fail+1)); }
# monthly summary (264)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/gifts/mine/monthly"); c=$(code "$r")
t "GET monthly gift summary" 200 "$c"
echo "$(body "$r")" | grep -q '"months"' && { echo "PASS: monthly summary has months"; pass=$((pass+1)); } || { echo "FAIL: monthly summary"; fail=$((fail+1)); }
# gift timeline on a bill (239)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/gifts/bill/$BILL_ID"); c=$(code "$r")
t "GET gift timeline on bill" 200 "$c"
# basket (246-248)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/basket" $J -d "{\"billId\":\"$BILL_ID\",\"amountMinor\":25000}"); c=$(code "$r")
t "POST basket add" 201 "$c"
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/basket")
echo "$r" | grep -q "$BILL_ID" && { echo "PASS: basket has bill"; pass=$((pass+1)); } || { echo "FAIL: basket item"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X PUT "$B/basket/$BILL_ID" $J -d '{"amountMinor":30000}'); c=$(code "$r")
t "PUT basket amount" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X DELETE "$B/basket/$BILL_ID"); c=$(code "$r")
t "DELETE basket item" 200 "$c"
# pledges (266-269)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges" $J -d "{\"billId\":\"$BILL_ID\",\"frequency\":\"monthly\",\"amountMinor\":50000}"); c=$(code "$r")
t "POST pledge monthly" 201 "$c"
PLEDGE_ID=$(body "$r" | jget "['pledge']['id']")
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges" $J -d "{\"billId\":\"$BILL_ID\",\"frequency\":\"weekly\",\"amountMinor\":50000}"); c=$(code "$r")
t "POST pledge duplicate -> 409" 409 "$c"
r=$(curl -s -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" "$B/pledges/mine")
echo "$r" | grep -q "$PLEDGE_ID" && { echo "PASS: my pledges lists it"; pass=$((pass+1)); } || { echo "FAIL: my pledges"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges/$PLEDGE_ID/pause" $J -d '{}'); c=$(code "$r")
t "POST pledge pause" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges/$PLEDGE_ID/resume" $J -d '{}'); c=$(code "$r")
t "POST pledge resume" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges/$PLEDGE_ID/mark-sent" $J -d '{}'); c=$(code "$r")
t "POST pledge mark-sent" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/pledges/$PLEDGE_ID/cancel" $J -d '{}'); c=$(code "$r")
t "POST pledge cancel" 200 "$c"
# dispute thread + fee review (242/280)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts/$GIFT2_ID/dispute" $J -d '{"note":"Details never arrived"}'); c=$(code "$r")
t "POST gift dispute" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts/$GIFT2_ID/messages" $J -d '{"body":"Where did it go?"}'); c=$(code "$r")
t "POST dispute thread message" 201 "$c"
r=$(curl -s -b "$TMPD/c-poster.txt" -H "$CSRF_H: $T_POSTER" "$B/gifts/$GIFT2_ID/messages")
echo "$r" | grep -q 'Where did it go' && { echo "PASS: poster reads thread message"; pass=$((pass+1)); } || { echo "FAIL: thread message"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-supporter.txt" -H "$CSRF_H: $T_SUPPORTER" -X POST "$B/gifts/$GIFT2_ID/fee-review" $J -d '{"case":"details_never_shown"}'); c=$(code "$r")
t "POST fee review" 200 "$c"
# admin dispute centre + fees history + tips + analytics (281/219/225/297)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" "$B/admin/disputes?status=open"); c=$(code "$r")
t "GET admin disputes" 200 "$c"
echo "$(body "$r")" | grep -q "$GIFT2_ID" && { echo "PASS: dispute listed in centre"; pass=$((pass+1)); } || { echo "FAIL: dispute in centre"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" "$B/admin/disputes/$GIFT2_ID"); c=$(code "$r")
t "GET admin disputes detail" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" -X POST "$B/admin/disputes/$GIFT2_ID/message" $J -d '{"body":"We are looking into this."}'); c=$(code "$r")
t "POST admin dispute message" 201 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" -X POST "$B/admin/disputes/$GIFT2_ID/resolve" $J -d '{}'); c=$(code "$r")
t "POST admin dispute resolve" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" "$B/admin/fees/history"); c=$(code "$r")
t "GET admin fees history" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" "$B/admin/tips"); c=$(code "$r")
t "GET admin tips" 200 "$c"
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" "$B/admin/analytics/gifts"); c=$(code "$r")
t "GET admin gift analytics" 200 "$c"
echo "$(body "$r")" | grep -q '"funnel"' && { echo "PASS: analytics funnel present"; pass=$((pass+1)); } || { echo "FAIL: analytics funnel"; fail=$((fail+1)); }
# billers (272/277)
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" -X POST "$B/admin/billers" $J -d '{"name":"Test Power","category":"electricity","country":"NP","refFormat":"12-digit consumer no","refHint":"On the top-right of the bill"}'); c=$(code "$r")
t "POST admin biller" 201 "$c"
BILLER_ID=$(body "$r" | jget "['id']")
r=$(curl -s "$B/billers?country=NP")
echo "$r" | grep -q 'Test Power' && { echo "PASS: public biller directory lists it"; pass=$((pass+1)); } || { echo "FAIL: biller directory"; fail=$((fail+1)); }
r=$(curl -s -w '\n%{http_code}' -b "$TMPD/c-admin.txt" -H "$CSRF_H: $T_ADMIN" -X DELETE "$B/admin/billers/$BILLER_ID"); c=$(code "$r")
t "DELETE admin biller (deactivate)" 200 "$c"
# leaders currency split (289)
r=$(curl -s "$B/leaders?tab=top_supporters&period=all&scope=all&currency=NPR")
echo "$r" | grep -q '"currency":"NPR"' && { echo "PASS: leaders currency=NPR echoed"; pass=$((pass+1)); } || { echo "FAIL: leaders currency"; fail=$((fail+1)); }
# profile impact (299)
SUP_UNAME=$(curl -s -b "$TMPD/c-supporter.txt" "$B/auth/me" | jget "['user']['username']")
r=$(curl -s "$B/profile/$SUP_UNAME")
echo "$r" | grep -q '"impact"' && echo "$r" | grep -q '"confirmedGifts":1' && { echo "PASS: profile impact has 1 confirmed gift"; pass=$((pass+1)); } || { echo "FAIL: profile impact: $r"; fail=$((fail+1)); }

# --- DB-backed rate limiting: 429 + Retry-After (LAST: burns the admin-login bucket) ---
# admin-login hits so far: before-setup(1) + wrong(1) + correct(1) + re-login(1) = 4 of 10.
for i in 1 2 3 4 5 6 7 8; do curl -s -o /dev/null -X POST "$B/admin/login" $J -d '{"pin":"wrongpin"}'; done
r=$(curl -s -i -X POST "$B/admin/login" $J -d '{"pin":"wrongpin"}')
echo "$r" | grep -qi '429' && { echo "PASS: 13th admin login -> 429"; pass=$((pass+1)); } || { echo "FAIL: expected 429"; fail=$((fail+1)); }
echo "$r" | grep -qi 'retry-after: [0-9]' && { echo "PASS: 429 carries Retry-After"; pass=$((pass+1)); } || { echo "FAIL: Retry-After header missing"; fail=$((fail+1)); }

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
