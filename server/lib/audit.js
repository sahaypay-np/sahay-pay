// Sahay Pay — audit log helper. Every privileged action, every payout-account
// reveal, and every approval decision is written here (who/when/what).
// Payout account values are NEVER written to audit logs.

'use strict';

const crypto = require('crypto');
const db = require('../db');

const nowIso = () => new Date().toISOString();

async function logAudit(actorType, actorId, action, targetType, targetId, meta = {}) {
  try {
    await db.run(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, meta_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), actorType, actorId, action, targetType, targetId, JSON.stringify(meta), nowIso()]
    );
  } catch (err) {
    // Audit failure must never break the action itself — but it must be loud.
    console.error('[audit] FAILED to write audit log:', err.message, { action, targetType, targetId });
  }
}

module.exports = { logAudit, nowIso };
