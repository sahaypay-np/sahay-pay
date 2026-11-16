// Sahay Pay — thank-you notes (Phase 2 §7, items 692–695).
// The bill owner (recipient) can send a short note to each giver after a
// gift is confirmed, and choose to share it on the bill's public
// thank-you wall. The giver gets a notification linking to the note.
// POST /api/thanks {giftId, body, isPublic}
// GET  /api/thanks/bill/:billId — public wall (shared notes only)
// GET  /api/thanks/mine — notes I received

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createNotification } = require('../lib/notify');

const router = express.Router();

router.post('/', requireActive, async (req, res, next) => {
  try {
    const giftId = cleanStr(req.body?.giftId, 64);
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the person who received the gift can thank the giver.' } });
    }
    if (gift.status !== 'confirmed') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Thank-you notes are for confirmed gifts.' } });
    }
    const body = cleanStr(req.body?.body, 500);
    if (body.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Write a short thank-you note first.' } });
    }
    const existing = await db.get('SELECT id FROM thank_you_notes WHERE gift_id = $1', [gift.id]);
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_THANKED', message: 'You already sent a thank-you note for this gift.' } });
    }
    const id = crypto.randomUUID();
    const isPublic = req.body?.isPublic === true ? 1 : 0;
    await db.run(
      `INSERT INTO thank_you_notes (id, bill_id, gift_id, sender_id, recipient_id, body, is_public, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, bill.id, gift.id, req.user.id, gift.supporter_id, body, isPublic, nowIso()]
    );
    await createNotification(
      gift.supporter_id, 'thank_you_received', 'Someone thanked you',
      `${req.user.displayName} sent you a thank-you note for your help on "${bill.title}".`,
      `#/bill/${bill.id}`
    );
    await logAudit('user', req.user.id, 'thank_you_sent', 'gift', gift.id, { noteId: id, isPublic: Boolean(isPublic) });
    res.status(201).json({ ok: true, noteId: id });
  } catch (err) {
    next(err);
  }
});

// Public thank-you wall (694): notes the recipient chose to share.
router.get('/bill/:billId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT n.id, n.body, n.created_at, u.display_name AS sender_name
       FROM thank_you_notes n JOIN users u ON u.id = n.sender_id
       WHERE n.bill_id = $1 AND n.is_public = 1 ORDER BY n.created_at ASC LIMIT 50`,
      [req.params.billId]
    );
    res.json({
      notes: rows.map((r) => ({
        id: r.id, body: r.body, senderName: r.sender_name, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Notes I received.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT n.id, n.bill_id, n.gift_id, n.body, n.is_public, n.created_at,
              b.title AS bill_title, u.display_name AS sender_name
       FROM thank_you_notes n JOIN bills b ON b.id = n.bill_id JOIN users u ON u.id = n.sender_id
       WHERE n.recipient_id = $1 ORDER BY n.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({
      notes: rows.map((r) => ({
        id: r.id, billId: r.bill_id, giftId: r.gift_id, body: r.body,
        isPublic: r.is_public === 1, billTitle: r.bill_title,
        senderName: r.sender_name, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
