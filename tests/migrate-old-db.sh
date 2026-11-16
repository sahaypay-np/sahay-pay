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
# Sanity: the old DB really lacks the new column.
OLD_COLS=$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/sahay-pay.db');
const cols = db.prepare(\"PRAGMA table_info(users)\").all().map(r => r.name);
console.log(cols.includes('recovery_code_lookup') ? 'HAS' : 'LACKS');
db.close();")
t "old DB lacks recovery_code_lookup" "LACKS" "$OLD_COLS"

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
// Phase 2 §9 columns/table (EXTRA_COLUMNS + schema file).
const billCols = db.prepare(\"PRAGMA table_info(bills)\").all().map(r => r.name);
const giftCols = db.prepare(\"PRAGMA table_info(gifts)\").all().map(r => r.name);
const complaintCols = db.prepare(\"PRAGMA table_info(complaints)\").all().map(r => r.name);
const adminSessCols = db.prepare(\"PRAGMA table_info(admin_sessions)\").all().map(r => r.name);
const uploadsTbl = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='uploads'\").all();
const uploadsIdx = db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_uploads_user'\").all();
console.log([
  cols.includes('recovery_code_lookup') ? 'COL_OK' : 'COL_MISSING',
  cols.includes('terms_accepted_version') ? 'CONSENT_OK' : 'CONSENT_MISSING',
  idx.length ? 'IDX_OK' : 'IDX_MISSING',
  hash ? 'HASH_OK' : 'HASH_MISSING',
  sessCols.includes('csrf_token') ? 'CSRF_OK' : 'CSRF_MISSING',
  rate.length ? 'RATELIMIT_OK' : 'RATELIMIT_MISSING',
  (sessCols.includes('ua_family_hash') && sessCols.includes('trusted_note') && sessCols.includes('reauthed_at')) ? 'SESS9_OK' : 'SESS9_MISSING',
  cols.includes('device_fp') ? 'USERDEV_OK' : 'USERDEV_MISSING',
  (billCols.includes('payout_edited_at') && billCols.includes('payout_consent_at')) ? 'BILLS9_OK' : 'BILLS9_MISSING',
  giftCols.includes('payment_method') ? 'GIFTS9_OK' : 'GIFTS9_MISSING',
  complaintCols.includes('category') ? 'COMPLAINTS9_OK' : 'COMPLAINTS9_MISSING',
  adminSessCols.includes('elevated_until') ? 'ADMINSESS9_OK' : 'ADMINSESS9_MISSING',
  uploadsTbl.length ? 'UPLOADS_OK' : 'UPLOADS_MISSING',
  uploadsIdx.length ? 'UPLOADS_IDX_OK' : 'UPLOADS_IDX_MISSING',
].join(' '));
db.close();")
for want in COL_OK CONSENT_OK IDX_OK HASH_OK CSRF_OK RATELIMIT_OK SESS9_OK USERDEV_OK BILLS9_OK GIFTS9_OK COMPLAINTS9_OK ADMINSESS9_OK UPLOADS_OK UPLOADS_IDX_OK; do
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
