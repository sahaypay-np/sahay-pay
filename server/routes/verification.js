// Sahay Pay — verification routes.
// POST /api/verification {type, billId?, docUrl, docType?} — request a badge.
// GET /api/verification/mine — own verification rows with statuses.
// Badges: bill | id | name | biller. A HUMAN (the owner, via admin review)
// grants every badge — nothing is verified automatically.
// Badge expiry (Phase 2 item 306): ID/name/biller badges last 12 months
// from approval; a bill badge lasts as long as its bill (the bill's own
// expiry). Expired badges stop showing as verified; the centre prompts
// re-verification. Document hashes (item 324) are computed server-side
// from the stored file — never trusted from the client.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { pathForUploadRef } = require('../lib/storage');
const { sha256File } = require('../lib/images');

const router = express.Router();

const TYPES = ['bill', 'id', 'name', 'biller'];
const DOC_TYPES = ['bill', 'id_card', 'passport', 'bank_statement', 'other'];

function isExpiredRow(row) {
  return row.status === 'approved' && row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

function publicRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    billId: row.bill_id,
    type: row.type,
    status: row.status,
    docType: row.doc_type || '',
    docHash: row.doc_hash || null,
    reviewerNote: row.reviewer_note || '',
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    expired: isExpiredRow(row),
  };
}

router.post('/', requireActive, async (req, res, next) => {
  try {
    const type = cleanStr(req.body?.type, 16);
    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Type must be bill, id, name or biller.' } });
    }
    const docType = DOC_TYPES.includes(req.body?.docType) ? req.body.docType : '';
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
    // Hash the stored document server-side (item 324). A missing file
    // (e.g. an ephemeral serverless upload that vanished) must not block
    // the request — the hash is simply absent.
    let docHash = null;
    if (docUrl) {
      const diskPath = pathForUploadRef(docUrl);
      if (diskPath) {
        try { docHash = sha256File(diskPath); } catch { /* hash stays null */ }
      }
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO verifications (id, user_id, bill_id, type, status, doc_url, doc_hash, doc_type, reviewer_note, expires_at, created_at, decided_at)
       VALUES ($1, $2, $3, $4, 'submitted', $5, $6, $7, '', NULL, $8, NULL)`,
      [id, req.user.id, billId, type, docUrl, docHash, docType, nowIso()]
    );
    await logAudit('user', req.user.id, 'verification_submitted', 'verification', id, { type, billId, docType });
    const row = await db.get('SELECT * FROM verifications WHERE id = $1', [id]);
    res.status(201).json({ verification: publicRow(row) });
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
    res.json({ verifications: rows.map(publicRow) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isExpiredRow = isExpiredRow;
