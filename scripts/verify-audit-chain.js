#!/usr/bin/env node
// Sahay Pay — verify the audit-log hash chain (item 721).
// Usage: node scripts/verify-audit-chain.js   (uses the local SQLite DB,
// or DATABASE_URL when set — same resolution as the server).
// Exits 0 when the chain is intact, 1 when broken or on error.
// Pre-chain entries (NULL hashes, written before the feature) are skipped
// and counted, not treated as tampering.
'use strict';

const path = require('path');

async function main() {
  const { verifyAuditChain } = require(path.join(__dirname, '..', 'server', 'lib', 'audit'));
  const db = require(path.join(__dirname, '..', 'server', 'db'));
  await db.migrate();
  const result = await verifyAuditChain();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error('AUDIT CHAIN BROKEN at:', result.brokenAt);
    process.exit(1);
  }
  console.log(`OK: ${result.checked} hashed entries verified, ${result.skippedPreChain} pre-chain entries skipped.`);
  await db.close();
}

main().catch((err) => {
  console.error('[verify-audit-chain] failed:', err.message);
  process.exit(1);
});
