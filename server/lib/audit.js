// Sahay Pay — audit log helper. Every privileged action, every payout-account
// reveal, and every approval decision is written here (who/when/what).
// Payout account values are NEVER written to audit logs.
//
// Item 721 (tamper-evidence): each entry carries a hash chained to the
// previous entry — entry_hash = sha256(prev_hash | id | actor | action |
// target | meta | created_at), prev_hash = the previous entry's entry_hash
// (or the GENESIS hash for the first hashed entry). Entries written before
// this feature have NULL hashes and are skipped by verification (they are
// pre-chain history, not evidence of tampering). Order is (created_at,
// id) for both insert and verification, so the chain is deterministic.
// Concurrent inserts in a serverless deployment could fork the chain if
// two writes read the same prev hash — the verifier flags that loudly
// rather than silently passing; see scripts/verify-audit-chain.js.

'use strict';

const crypto = require('crypto');
const db = require('../db');

const nowIso = () => new Date().toISOString();
const GENESIS_HASH = crypto.createHash('sha256').update('sahay-pay-audit-genesis').digest('hex');

function hashEntry({ prevHash, id, actorType, actorId, action, targetType, targetId, metaJson, createdAt }) {
  return crypto
    .createHash('sha256')
    .update([prevHash, id, actorType, actorId, action, targetType, targetId, metaJson, createdAt].join('|'))
    .digest('hex');
}

async function logAudit(actorType, actorId, action, targetType, targetId, meta = {}) {
  try {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const metaJson = JSON.stringify(meta);
    // Previous hash: the latest entry that HAS a hash (pre-chain rows have NULL).
    const prev = await db.get(
      `SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`
    );
    const prevHash = prev?.entry_hash || GENESIS_HASH;
    const entryHash = hashEntry({
      prevHash, id, actorType, actorId, action, targetType, targetId, metaJson, createdAt,
    });
    await db.run(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, meta_json, prev_hash, entry_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, actorType, actorId, action, targetType, targetId, metaJson, prevHash, entryHash, createdAt]
    );
  } catch (err) {
    // Audit failure must never break the action itself — but it must be loud.
    console.error('[audit] FAILED to write audit log:', err.message, { action, targetType, targetId });
  }
}

// Verify the hash chain over the hashed entries (oldest first). Returns
// {ok, checked, skippedPreChain, brokenAt} — brokenAt is the first entry
// whose prev_hash or recomputed hash does not match, or null.
async function verifyAuditChain(limit = 10000) {
  const { rows } = await db.query(
    'SELECT * FROM audit_logs ORDER BY created_at ASC, id ASC LIMIT $1',
    [limit]
  );
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let skippedPreChain = 0;
  for (const row of rows) {
    if (!row.entry_hash) {
      skippedPreChain++;
      continue; // pre-chain history — cannot be verified, not tampering
    }
    const metaJson = row.meta_json || '{}';
    const expected = hashEntry({
      prevHash,
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metaJson,
      createdAt: row.created_at,
    });
    if (row.prev_hash !== prevHash || row.entry_hash !== expected) {
      return { ok: false, checked, skippedPreChain, brokenAt: { id: row.id, action: row.action, createdAt: row.created_at } };
    }
    prevHash = row.entry_hash;
    checked++;
  }
  return { ok: true, checked, skippedPreChain, brokenAt: null };
}

module.exports = { logAudit, nowIso, verifyAuditChain, GENESIS_HASH, hashEntry };
