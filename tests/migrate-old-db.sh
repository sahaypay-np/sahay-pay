#!/bin/bash
# Sahay Pay — old-database migration regression test.
# Regression for the 2026-11-16 live outage: migrate() ran the schema file
# (with an index on the new users.recovery_code_lookup column) BEFORE the
# ALTERs that add that column, so every API route 502'd on the EXISTING
# live database — while all fresh-DB suites passed. This test builds a
# database from the schema file at a pre-change commit, starts the CURRENT
# server against it, and verifies the migrate succeeds and the new columns
# + index exist afterwards.
# Usage: ./tests/migrate-old-db.sh [base-commit]  (default b8defcb, pre-B)
# Exits non-zero on any failure. Uses a throwaway local SQLite DB only.
# The premise check asserts the old DB lacks the NEWEST schema additions
# (phase-2 s1-2 bill columns), so any pre-change base works — including a
# recent one such as the live schema. The post-migrate checks cover both
# the phase-1 columns and the phase-2 bill columns + bill_edits table.
set -u
BASE_COMMIT="${1:-b8defcb}"
PORT="${MIGRATE_TEST_PORT:-3105}"
cd "$(dirname "$0")/.." || exit 1
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; pass=$((pass+1)); else echo "FAIL: $1 — expected $2, got $3"; fail=$((fail+1)); fi; }

# 1. Build an old-schema DB (no recovery-code / consent / CSRF columns).
git show "$BASE_COMMIT:server/schema.sqlite.sql" > /tmp/old-schema.sql || { echo "FAIL: cannot read old schema at $BASE_COMMIT"; exit 1; }
rm -rf data && mkdir -p data
node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const db = new DatabaseSync('data/sahay-pay.db');
db.exec(fs.readFileSync('/tmp/old-schema.sql', 'utf8'));
db.close();
" || { echo "FAIL: could not build old-schema DB"; exit 1; }
# Sanity: the old DB really lacks the newest columns (phase-2 s4-6 bill
# columns — the migration under test). Any pre-change base lacks them,
# including b7637d2 (which already has the s1-2 columns).
OLD_COLS=$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/sahay-pay.db');
const cols = db.prepare(\"PRAGMA table_info(bills)\").all().map(r => r.name);
console.log(cols.includes('share_count') ? 'HAS' : 'LACKS');
db.close();")
t "old DB lacks new bill columns (share_count)" "LACKS" "$OLD_COLS"

# 2. Start the CURRENT server against the old DB.
PORT=$PORT SESSION_SECRET=$(openssl rand -base64 48) PAYOUT_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  CLAUDE_APPROVAL_BRIDGE_SECRET=test-bridge-secret \
  node ./server/index.js > /tmp/migrate-old-db.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf data' EXIT
UP=0
for _ in $(seq 1 40); do
  curl -sf http://localhost:$PORT/api/health >/dev/null 2>&1 && { UP=1; break; }
  sleep 1
done
t "server starts against old DB (health 200)" 1 "$UP"
HEALTH=$(curl -s http://localhost:$PORT/api/health)
echo "$HEALTH" | grep -q '"ok":true' && echo "PASS: health body ok" && pass=$((pass+1)) || { echo "FAIL: health body — got: $HEALTH"; fail=$((fail+1)); }
CONFIG_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/api/config)
t "config 200 after migrate" 200 "$CONFIG_CODE"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; trap - EXIT

# 3. Verify the migrate added the columns + index + schema hash.
CHECKS=$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/sahay-pay.db');
const cols = db.prepare(\"PRAGMA table_info(users)\").all().map(r => r.name);
const idx = db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_recovery'\").all();
const hash = db.prepare(\"SELECT value FROM settings WHERE key='schema_hash'\").get();
const sessCols = db.prepare(\"PRAGMA table_info(sessions)\").all().map(r => r.name);
const rate = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits'\").all();
const billCols = db.prepare(\"PRAGMA table_info(bills)\").all().map(r => r.name);
const newBillCols = ['for_whom','relationship','for_other_consent','about_me','biller_instructions','photos_json','story_lang','not_paid_consequence','tried_to_pay','money_means','bill_type_other','charity_name','business','business_name','business_desc','dream','dream_desc','expires_at','extension_used','repost_count'];
const editsTbl = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='bill_edits'\").all();
const editsIdx = db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bill_edits_bill'\").all();
// Phase 2 sections 4–6: new tables + new columns on existing tables.
const newTables = ['follows','user_blocks','achievements','thanks','thank_reactions','receiver_stories','brand_profiles','brand_responses','message_threads','messages','partnerships','drops','drop_entries','csr_updates','appeals','signin_history','fraud_flags','auction_watchlist','scam_notices','anon_stats'];
const haveTables = new Set(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));
const tableCols = (t) => db.prepare(\"PRAGMA table_info(\" + t + \")\").all().map(r => r.name);
const newColsOk =
  billCols.includes('share_count') && billCols.includes('fraud_band') &&
  tableCols('gifts').includes('anonymous') &&
  tableCols('verifications').includes('expires_at') &&
  cols.includes('cover_url') && cols.includes('suspended_reason') &&
  tableCols('brands').includes('visual_url') &&
  tableCols('auctions').includes('buyer_settled') &&
  tableCols('reports').includes('decision') &&
  tableCols('complaints').includes('category');
console.log([
  cols.includes('recovery_code_lookup') ? 'COL_OK' : 'COL_MISSING',
  cols.includes('terms_accepted_version') ? 'CONSENT_OK' : 'CONSENT_MISSING',
  idx.length ? 'IDX_OK' : 'IDX_MISSING',
  hash ? 'HASH_OK' : 'HASH_MISSING',
  sessCols.includes('csrf_token') ? 'CSRF_OK' : 'CSRF_MISSING',
  rate.length ? 'RATELIMIT_OK' : 'RATELIMIT_MISSING',
  newBillCols.every(c => billCols.includes(c)) ? 'BILLCOLS_OK' : 'BILLCOLS_MISSING',
  editsTbl.length ? 'BILLEDITS_OK' : 'BILLEDITS_MISSING',
  editsIdx.length ? 'BILLEDITSIDX_OK' : 'BILLEDITSIDX_MISSING',
  newTables.every(t => haveTables.has(t)) ? 'S46TABLES_OK' : 'S46TABLES_MISSING',
  newColsOk ? 'S46COLS_OK' : 'S46COLS_MISSING',
].join(' '));
db.close();")
for want in COL_OK CONSENT_OK IDX_OK HASH_OK CSRF_OK RATELIMIT_OK BILLCOLS_OK BILLEDITS_OK BILLEDITSIDX_OK S46TABLES_OK S46COLS_OK; do
  if echo "$CHECKS" | grep -q "$want"; then echo "PASS: $want"; pass=$((pass+1)); else echo "FAIL: $want — checks: $CHECKS"; fail=$((fail+1)); fi
done

# 4. Second boot must take the fast path (schema hash matches) and stay up.
PORT=$PORT SESSION_SECRET=$(openssl rand -base64 48) PAYOUT_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  CLAUDE_APPROVAL_BRIDGE_SECRET=test-bridge-secret \
  node ./server/index.js > /tmp/migrate-old-db-2.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf data' EXIT
UP=0
for _ in $(seq 1 40); do
  curl -sf http://localhost:$PORT/api/health >/dev/null 2>&1 && { UP=1; break; }
  sleep 1
done
t "second boot healthy (hash fast-path)" 1 "$UP"
grep -q "migrate skipped" /tmp/migrate-old-db-2.log && echo "PASS: second boot skipped migrate (hash match)" && pass=$((pass+1)) || { echo "FAIL: second boot did not skip migrate"; fail=$((fail+1)); }
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
rm -rf data

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
