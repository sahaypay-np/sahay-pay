#!/usr/bin/env node
// scripts/reencrypt-payouts.js — re-encrypt every stored payout account
// under a NEW master key (Phase 2 items 832/888).
//
//   OLD key: PAYOUT_ENCRYPTION_KEY=<current key>  (env, as usual)
//   NEW key: NEW_PAYOUT_ENCRYPTION_KEY=<base64 or hex of 32 bytes>
//   DB:      DATABASE_URL, or the local SQLite file (data/sahay-pay.db)
//
//   node scripts/reencrypt-payouts.js --dry-run   # counts rows, changes nothing
//   node scripts/reencrypt-payouts.js             # re-encrypts in place
//
// SAFETY:
// - Run against a BACKUP COPY first, verify a decrypt round-trip, then
//   run against the real database. Never run blind against live.
// - After a successful run, set PAYOUT_ENCRYPTION_KEY to the new key in
//   Netlify and redeploy IMMEDIATELY: until then the app still uses the
//   old key and the new ciphertexts are unreadable.
// - Keep the old key for 30 days after rotation (in the password manager,
//   never in the repo), then destroy it.
// - The script never prints plaintext accounts — only counts and ids.
'use strict';
const crypto = require('crypto');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');

function parseKey(raw, name) {
  if (!raw) {
    console.error(`Missing ${name} (base64 or hex of exactly 32 bytes).`);
    process.exit(2);
  }
  for (const enc of ['base64', 'hex']) {
    try {
      const buf = Buffer.from(raw, enc);
      if (buf.length === 32) return buf;
    } catch { /* try next */ }
  }
  console.error(`${name} must be base64 or hex of exactly 32 bytes.`);
  process.exit(2);
}

const newMasterKey = parseKey(process.env.NEW_PAYOUT_ENCRYPTION_KEY, 'NEW_PAYOUT_ENCRYPTION_KEY');

// Requiring storage resolves the OLD key from PAYOUT_ENCRYPTION_KEY (or
// SESSION_SECRET, as in production). If neither is set it throws/warns.
const { reencryptAccount, decryptAccount } = require(path.join(__dirname, '..', 'server', 'lib', 'storage'));
const db = require(path.join(__dirname, '..', 'server', 'db'));

async function main() {
  const rows = (await db.query('SELECT id, method, account_enc FROM payout_methods')).rows;
  console.log(`Found ${rows.length} payout row(s).${dryRun ? ' [dry run — nothing will change]' : ''}`);
  let ok = 0;
  let failed = [];
  for (const row of rows) {
    try {
      const next = reencryptAccount(row.account_enc, row.method, newMasterKey);
      // Round-trip check with the NEW key before writing anything.
      const key = crypto.createHmac('sha256', newMasterKey).update(`sahay-pay-field:${row.method || 'account'}`).digest();
      const buf = Buffer.from(next.slice(3), 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
      const original = decryptAccount(row.account_enc, row.method);
      if (plain !== original) throw new Error('round-trip mismatch');
      if (!dryRun) {
        await db.run('UPDATE payout_methods SET account_enc = $1 WHERE id = $2', [next, row.id]);
      }
      ok += 1;
    } catch (err) {
      failed.push({ id: row.id, error: err.message });
    }
  }
  console.log(`Re-encrypted OK: ${ok}/${rows.length}`);
  if (failed.length) {
    console.error(`FAILED (${failed.length}):`);
    for (const f of failed) console.error(`  ${f.id}: ${f.error}`);
    console.error('Aborting: fix the failed rows (they may use an older key) before deploying the new key.');
    process.exit(1);
  }
  if (dryRun) {
    console.log('Dry run passed. Re-run without --dry-run to apply, then update PAYOUT_ENCRYPTION_KEY in Netlify and redeploy immediately.');
  } else {
    console.log('Done. NOW update PAYOUT_ENCRYPTION_KEY in Netlify to the new key and redeploy immediately.');
  }
}

main().catch((err) => {
  console.error('reencrypt-payouts failed:', err.message);
  process.exit(1);
});
