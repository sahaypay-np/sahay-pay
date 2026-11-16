// Sahay Pay — payout-reveal anomaly detection + reveal counting.
// (Phase 2 items 826/827/828/845/887.)
// All checks are lazy, computed from the audit log at reveal time — there
// is no scheduler and no background job in this product.
// An "anomaly" is a reveal from a device class the account has never
// revealed from before, or a reveal at unusual hours (21:00–04:00 UTC,
// roughly 02:45–09:45 NPT — the small hours in Nepal/India). Anomalies are
// audit-logged and flagged for owner review; they never block a reveal on
// their own (the caps in 828/845 do the blocking).

'use strict';

const db = require('../db');

const REVEAL_DAILY_CAP_PER_ACCOUNT = 10; // item 828
const REVEAL_DAILY_CAP_PER_BILL = 20; // item 845
const REVEAL_ALERT_THRESHOLD = 8; // item 826: flag at N reveals/day

function dayAgoIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

async function countRevealsByUser(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM audit_logs
     WHERE action = 'payout_revealed' AND actor_id = $1 AND created_at >= $2`,
    [userId, dayAgoIso()]
  );
  return Number(row?.c || 0);
}

async function countRevealsByBill(billId) {
  // The bill id is stored in the audit meta JSON as "billId".
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM audit_logs
     WHERE action = 'payout_revealed' AND created_at >= $1
       AND meta_json LIKE $2`,
    [dayAgoIso(), `%"billId":"${billId}"%`]
  );
  return Number(row?.c || 0);
}

// Device classes this user has revealed from before (from audit meta).
async function knownRevealDeviceClasses(userId) {
  const { rows } = await db.query(
    `SELECT meta_json FROM audit_logs
     WHERE action = 'payout_revealed' AND actor_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  const seen = new Set();
  for (const r of rows) {
    try {
      const m = JSON.parse(r.meta_json || '{}');
      if (m.deviceClass) seen.add(m.deviceClass);
    } catch { /* ignore */ }
  }
  return seen;
}

function isUnusualHour(date = new Date()) {
  const h = date.getUTCHours();
  return h >= 21 || h < 4;
}

// Returns { anomaly, reasons[] } — reasons: 'new_device' | 'unusual_hours'.
async function detectRevealAnomaly(userId, deviceClass) {
  const reasons = [];
  if (isUnusualHour()) reasons.push('unusual_hours');
  const known = await knownRevealDeviceClasses(userId);
  if (known.size > 0 && deviceClass && !known.has(deviceClass)) reasons.push('new_device');
  return { anomaly: reasons.length > 0, reasons };
}

// Item 826: accounts over the daily reveal-alert threshold (for the admin
// security view). Computed lazily on read.
async function accountsOverRevealThreshold() {
  const { rows } = await db.query(
    `SELECT actor_id AS user_id, COUNT(*) AS c FROM audit_logs
     WHERE action = 'payout_revealed' AND created_at >= $1
     GROUP BY actor_id HAVING COUNT(*) >= $2 ORDER BY c DESC`,
    [dayAgoIso(), REVEAL_ALERT_THRESHOLD]
  );
  return rows.map((r) => ({ userId: r.user_id, reveals24h: Number(r.c) }));
}

// Item 827: recent reveal anomalies for the admin security view.
async function recentRevealAnomalies(limit = 50) {
  const { rows } = await db.query(
    `SELECT actor_id, target_id, meta_json, created_at FROM audit_logs
     WHERE action = 'payout_reveal_anomaly' ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return rows.map((r) => {
    let meta = {};
    try { meta = JSON.parse(r.meta_json || '{}'); } catch { /* ignore */ }
    return {
      userId: r.actor_id,
      giftId: r.target_id,
      billId: meta.billId || null,
      reasons: meta.reasons || [],
      deviceClass: meta.deviceClass || null,
      createdAt: r.created_at,
    };
  });
}

module.exports = {
  REVEAL_DAILY_CAP_PER_ACCOUNT,
  REVEAL_DAILY_CAP_PER_BILL,
  REVEAL_ALERT_THRESHOLD,
  countRevealsByUser,
  countRevealsByBill,
  detectRevealAnomaly,
  accountsOverRevealThreshold,
  recentRevealAnomalies,
  isUnusualHour,
};
