// Sahay Pay — appeals (Phase 2 §8, items 739–740, user side).
// POST /api/appeals — file an appeal against a bill decision or a
// suspension. GET /api/appeals/mine — my appeals + their status.
// Admin decides via POST /api/admin/appeals/:id (approving restores the
// content). A user can have only one OPEN appeal per target.
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');

const router = express.Router();

router.post('/', requireActive, rateLimit('appeal', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const targetType = cleanStr(req.body?.targetType, 32);
    const targetId = cleanStr(req.body?.targetId, 64);
    const explanation = cleanStr(req.body?.explanation || '', 2000);
    if (!['bill', 'user'].includes(targetType)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Appeals can target a bill or your account.' } });
    }
    if (!targetId) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A target is required.' } });
    if (explanation.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please explain your appeal (10+ characters).' } });
    }
    // Own content only: a bill appeal must be for your own bill; a user
    // appeal must be for your own account.
    if (targetType === 'bill') {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [targetId]);
      if (!bill || bill.user_id !== req.user.id) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
      }
    } else if (targetId !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only appeal your own account.' } });
    }
    const existing = await db.get(
      `SELECT id FROM appeals WHERE user_id = $1 AND target_type = $2 AND target_id = $3 AND status = 'open'`,
      [req.user.id, targetType, targetId]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_OPEN', message: 'You already have an open appeal for this.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO appeals (id, user_id, target_type, target_id, body, status, reviewer_note, decided_by, created_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, 'open', '', '', $6, NULL)`,
      [id, req.user.id, targetType, targetId, explanation, nowIso()]
    );
    await logAudit('user', req.user.id, 'appeal_filed', targetType, targetId, { appealId: id });
    res.status(201).json({ ok: true, appealId: id, message: 'Appeal filed. A human moderator reviews every appeal.' });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ appeals: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
