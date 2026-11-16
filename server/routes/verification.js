// Sahay Pay — verification routes.
// POST /api/verification {type, billId?, docUrl} — request a badge.
// GET /api/verification/mine — own verification rows with statuses.
// Badges: bill | id | name | biller. A HUMAN (the owner, via admin review)
// grants every badge — nothing is verified automatically.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');

const router = express.Router();

const TYPES = ['bill', 'id', 'name', 'biller'];

router.post('/', requireActive, async (req, res, next) => {
  try {
    const type = cleanStr(req.body?.type, 16);
    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Type must be bill, id, name or biller.' } });
    }
    const billId = req.body?.billId ? cleanStr(req.body.billId, 64) : null;
    if (billId) {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
      if (!bill || bill.user_id !== req.user.id) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
      }
    }
    const docUrl = req.body?.docUrl ? cleanStr(req.body.docUrl, 500) : null;
    if ((type === 'bill' || type === 'id') && !docUrl) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Please upload the document for this verification (private — reviewer-only).' },
      });
    }
    // One open request per type per bill (or per user for id/name).
    const existing = await db.get(
      `SELECT id FROM verifications
       WHERE user_id = $1 AND type = $2 AND status IN ('submitted', 'under_review')
       AND ((bill_id IS NULL AND $3 IS NULL) OR bill_id = $4)`,
      [req.user.id, type, billId, billId]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_SUBMITTED', message: 'You already have an open verification request of this type.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO verifications (id, user_id, bill_id, type, status, doc_url, reviewer_note, created_at, decided_at)
       VALUES ($1, $2, $3, $4, 'submitted', $5, '', $6, NULL)`,
      [id, req.user.id, billId, type, docUrl, nowIso()]
    );
    await logAudit('user', req.user.id, 'verification_submitted', 'verification', id, { type, billId });
    const row = await db.get('SELECT * FROM verifications WHERE id = $1', [id]);
    res.status(201).json({ verification: row });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ verifications: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
