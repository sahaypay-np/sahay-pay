// Sahay Pay — reports & complaints routes.
// POST /api/reports {targetType, targetId, reason, note}
// POST /api/complaints {subject, body}
// A credible fraud report on an APPROVED bill immediately sets it
// under_investigation and hides it from the feed, pending owner review
// (ETA 2063 s.43: knowingly keeping a credibly reported scam live erodes the
// intermediary protection). Abuse guards: the bill's own owner can never
// pause their own bill; reporting an already-paused bill changes nothing;
// the pause is audit-logged and the owner is notified.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createNotification } = require('../lib/notify');

const router = express.Router();

// The 8 report reasons (Part C §15). The fraud set auto-pauses an approved bill.
const REASONS = [
  'possible_fraud', 'impersonation', 'deception', 'scam', 'personal_details',
  'offensive', 'under_18', 'other',
];
const FRAUD_REASONS = new Set(['possible_fraud', 'impersonation', 'deception', 'scam']);

router.post('/reports', requireActive, rateLimit('report', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const targetType = cleanStr(body.targetType, 32);
    const targetId = cleanStr(body.targetId, 64);
    const reason = cleanStr(body.reason, 32);
    const note = cleanStr(body.note || '', 600);
    if (!['bill', 'brand', 'auction', 'user'].includes(targetType)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Target type must be bill, brand, auction or user.' } });
    }
    if (!targetId) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A target is required.' } });
    if (!REASONS.includes(reason)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose a reason for the report.' } });
    }

    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, note, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
      [id, req.user.id, targetType, targetId, reason, note, nowIso()]
    );
    await logAudit('user', req.user.id, 'report_filed', targetType, targetId, { reportId: id, reason });

    let paused = false;
    if (targetType === 'bill' && FRAUD_REASONS.has(reason)) {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [targetId]);
      if (bill && bill.status === 'approved' && bill.user_id !== req.user.id) {
        await db.run(
          `UPDATE bills SET status = 'under_investigation', report_count = report_count + 1, updated_at = $1 WHERE id = $2`,
          [nowIso(), bill.id]
        );
        paused = true;
        await logAudit('system', 'auto-pause', 'bill_auto_paused', 'bill', bill.id, { reportId: id, reason });
        await createNotification(
          bill.user_id, 'bill_paused', 'Your bill is paused while it is checked',
          'Someone reported your bill as possible fraud. It is hidden from the feed while the owner checks it.',
          '#/mybills'
        );
      } else if (bill) {
        await db.run('UPDATE bills SET report_count = report_count + 1 WHERE id = $1', [bill.id]);
      }
    }

    res.status(201).json({
      ok: true,
      reportId: id,
      paused,
      message: paused
        ? 'Thanks — this bill is paused while the owner checks it.'
        : 'Thanks — a human moderator checks every report.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/complaints', requireActive, rateLimit('complaint', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    // Honeypot (item 788): the form carries a hidden "website" field no
    // human ever sees; bots fill it. Reject those submissions outright.
    // (The value is never logged or stored.)
    if (typeof req.body?.website === 'string' && req.body.website.trim() !== '') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Submission rejected.' } });
    }
    const subject = cleanStr(req.body?.subject, 200);
    const body = cleanStr(req.body?.body, 2000);
    if (subject.length < 3) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please give your complaint a subject.' } });
    if (body.length < 10) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please describe what happened (10+ characters).' } });
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO complaints (id, user_id, subject, body, status, created_at) VALUES ($1, $2, $3, $4, 'open', $5)`,
      [id, req.user.id, subject, body, nowIso()]
    );
    await logAudit('user', req.user.id, 'complaint_filed', 'complaint', id, {});
    res.status(201).json({ ok: true, complaintId: id, message: 'We review every complaint.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
