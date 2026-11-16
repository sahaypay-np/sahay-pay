// Sahay Pay — fraud-signal scoring (Phase 2 §4, items 331/332/398).
// An admin-assist risk model: it scores bills from observable signals and
// shows a band (low/medium/high) with the contributing signals. It NEVER
// auto-rejects or auto-pauses anything — the owner decides (the only
// automatic action in the product remains the fraud-report auto-pause in
// routes/reports.js). Weights are published in the admin panel (item 398).
// No fingerprinting, no hidden tracking (standing P1-269 decision): the
// signals use only account age, verification state, posting velocity,
// report history, document/image hashes and payout-edit timing.

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { nowIso } = require('./audit');

// Signal weights (published in the admin fraud panel, item 398).
const SIGNAL_WEIGHTS = {
  new_account: { weight: 20, label: 'Account less than 24 hours old' },
  high_value_new: { weight: 25, label: 'New account with a high-value bill (over रू/₹ 25,000)' },
  no_verification: { weight: 10, label: 'No approved verification badge' },
  rapid_posts: { weight: 20, label: '3+ bills posted in 24 hours' },
  report_history: { weight: 15, label: 'Each earlier report against this poster (max 30)' },
  duplicate_bill: { weight: 30, label: 'Same biller + amount as another live bill' },
  similar_image: { weight: 25, label: 'Bill photo closely matches another bill photo' },
  duplicate_document: { weight: 25, label: 'Verification document already submitted before' },
  rapid_payout_edits: { weight: 20, label: 'Payout details changed 2+ times in 24 hours' },
  name_similar_suspended: { weight: 15, label: 'Name closely matches a suspended account' },
  one_account_signals: { weight: 15, label: 'Duplicate-account signals (same device pattern + timing)' },
  velocity_cap_hit: { weight: 10, label: 'Hit a daily/weekly posting cap recently' },
};

const HIGH_VALUE_MINOR = 2500000; // रू/₹ 25,000

function bandForScore(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function addSignal(signals, key, detail) {
  const def = SIGNAL_WEIGHTS[key];
  if (!def) return;
  signals.push({ key, weight: def.weight, label: def.label, detail: detail || '' });
}

// Compute the risk score for one bill from live data. Returns
// { score, band, signals }. Pure read — no writes except the caller's
// choice to persist the score on the bill row.
async function computeRiskForBill(bill) {
  const signals = [];
  const user = await db.get('SELECT * FROM users WHERE id = $1', [bill.user_id]);
  const now = Date.now();
  const createdMs = user ? new Date(user.created_at).getTime() : 0;
  const ageHours = (now - createdMs) / 3600000;

  if (user && ageHours < 24) {
    addSignal(signals, 'new_account', `Account created ${Math.max(0, Math.floor(ageHours))}h ago`);
    if (bill.amount_minor >= HIGH_VALUE_MINOR) {
      addSignal(signals, 'high_value_new', `${bill.amount_minor / 100} ${bill.currency}`);
    }
  }
  const verif = await db.get(
    `SELECT COUNT(*) AS c FROM verifications WHERE user_id = $1 AND status = 'approved'`,
    [bill.user_id]
  );
  if (Number(verif?.c || 0) === 0) addSignal(signals, 'no_verification');

  const dayAgo = new Date(now - 24 * 3600000).toISOString();
  const recent = await db.get(
    `SELECT COUNT(*) AS c FROM bills WHERE user_id = $1 AND created_at >= $2`,
    [bill.user_id, dayAgo]
  );
  if (Number(recent?.c || 0) >= 3) {
    addSignal(signals, 'rapid_posts', `${recent.c} bills in 24h`);
  }

  const reports = await db.get(
    `SELECT COUNT(*) AS c FROM reports r
     WHERE r.target_type = 'bill' AND r.target_id IN (SELECT id FROM bills WHERE user_id = $1)`,
    [bill.user_id]
  );
  const reportCount = Number(reports?.c || 0);
  if (reportCount > 0) {
    // 15 per report, capped at 30 (two signal entries max).
    addSignal(signals, 'report_history', `${reportCount} earlier report(s)`);
    if (reportCount >= 2) addSignal(signals, 'report_history', 'repeat reports');
  }

  // Duplicate bill: same biller name + reference + amount on another live bill.
  if (bill.biller_ref || bill.biller_name) {
    const dup = await db.get(
      `SELECT id FROM bills WHERE id != $1 AND status IN ('approved','pending_review')
       AND amount_minor = $2 AND biller_name = $3 AND biller_ref = $4 LIMIT 1`,
      [bill.id, bill.amount_minor, bill.biller_name || '', bill.biller_ref || '']
    );
    if (dup) addSignal(signals, 'duplicate_bill', 'same biller + amount as another live bill');
  }

  // Rapid payout edits: 2+ bill_payout_changed audit entries in 24h.
  const edits = await db.get(
    `SELECT COUNT(*) AS c FROM audit_logs
     WHERE action = 'bill_payout_changed' AND target_id = $1 AND created_at >= $2`,
    [bill.id, dayAgo]
  );
  if (Number(edits?.c || 0) >= 2) {
    addSignal(signals, 'rapid_payout_edits', `${edits.c} payout changes in 24h`);
  }

  // Open fraud flags already recorded against this bill/user feed the score.
  const flags = await db.query(
    `SELECT signal FROM fraud_flags WHERE status = 'open' AND (bill_id = $1 OR user_id = $2)`,
    [bill.id, bill.user_id]
  );
  const flagKeys = new Set(flags.rows.map((r) => r.signal));
  if (flagKeys.has('similar_image')) addSignal(signals, 'similar_image');
  if (flagKeys.has('duplicate_document')) addSignal(signals, 'duplicate_document');
  if (flagKeys.has('name_similar_suspended')) addSignal(signals, 'name_similar_suspended');
  if (flagKeys.has('one_account_signals')) addSignal(signals, 'one_account_signals');
  if (flagKeys.has('duplicate_bill')) addSignal(signals, 'duplicate_bill');

  const score = signals.reduce((n, s) => n + s.weight, 0);
  return { score, band: bandForScore(score), signals };
}

// Record a fraud flag (dedupe: one open flag per bill/user + signal).
async function flagSignal({ billId = null, userId = null, signal, detail = '', severity = 'medium' }) {
  const existing = await db.get(
    `SELECT id FROM fraud_flags WHERE status = 'open' AND signal = $1
     AND ((bill_id IS NULL AND $2 IS NULL) OR bill_id = $3)
     AND ((user_id IS NULL AND $4 IS NULL) OR user_id = $5)`,
    [signal, billId, billId, userId, userId]
  );
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO fraud_flags (id, bill_id, user_id, signal, detail, severity, status, created_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, NULL)`,
    [id, billId, userId, signal, detail, severity, nowIso()]
  );
  return id;
}

// Persist the computed score/band on the bill row (admin queue reads it).
async function scoreBill(bill) {
  const risk = await computeRiskForBill(bill);
  await db.run('UPDATE bills SET fraud_score = $1, fraud_band = $2 WHERE id = $3', [risk.score, risk.band, bill.id]);
  return risk;
}

// Effective band: a manual override (item 344) wins over the computed band.
function effectiveBand(bill) {
  if (bill.fraud_override) return bill.fraud_override;
  return bill.fraud_band || 'low';
}

module.exports = {
  SIGNAL_WEIGHTS,
  HIGH_VALUE_MINOR,
  bandForScore,
  computeRiskForBill,
  flagSignal,
  scoreBill,
  effectiveBand,
};
