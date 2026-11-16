// Sahay Pay — gifts routes (the help journey).
// POST /api/gifts/quote, POST /api/gifts, POST /api/gifts/:id/reveal,
// POST /api/gifts/:id/reported-sent, POST /api/gifts/:id/confirm,
// POST /api/gifts/:id/not-received, POST /api/gifts/:id/dispute,
// GET /api/gifts/mine?type=given|received.
// Statuses: initiated -> details_shown -> donor_reported_sent -> confirmed.
// ONLY the recipient (bill owner) confirms. Only confirmed gifts credit the
// bill's covered amount (capped at the bill amount) and the leaderboards.
// Every payout reveal is audit-logged. Demo Mode: no real payment integration;
// the supporter sends the money in their own payment app.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { isMinorAmount } = require('../lib/money');
const { quote, feeModelSentence } = require('../lib/fees');
const { decryptAccount } = require('../lib/storage');
const { createNotification } = require('../lib/notify');
const { awardAchievements } = require('../lib/achievements');

const router = express.Router();

async function feeContext() {
  const feeMode = (await db.getSetting('fee_mode')) || 'supporter_fee';
  const feeConfig = await db.getSettingJson('fee_config', {});
  return { feeMode, feeConfig };
}

function publicGift(g) {
  return {
    id: g.id,
    billId: g.bill_id,
    supporterId: g.supporter_id,
    amountMinor: g.amount_minor,
    currency: g.currency,
    feeMinor: g.fee_minor,
    tipMinor: g.tip_minor,
    status: g.status,
    reference: g.reference,
    disputeNote: g.dispute_note,
    anonymous: g.anonymous === 1,
    createdAt: g.created_at,
    confirmedAt: g.confirmed_at,
  };
}

// POST /api/gifts/quote — the Check step: exact fee + total before any send.
router.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const { billId, amountMinor } = req.body || {};
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill is not open for help right now.' } });
    }
    const minGift = Number(await db.getSetting('min_gift_minor')) || 1000;
    if (amountMinor < minGift) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `The minimum help amount is ${minGift / 100} ${bill.currency}.` } });
    }
    const remaining = bill.amount_minor - bill.covered_minor;
    if (amountMinor > remaining) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
    }
    const { feeMode, feeConfig } = await feeContext();
    const q = quote(amountMinor, bill.currency, bill.charity === 1, feeMode, feeConfig);
    res.json({
      billId: bill.id,
      amountMinor,
      currency: bill.currency,
      feeMinor: q.feeMinor,
      totalMinor: q.totalMinor,
      feeMode: q.feeMode,
      feeModelSentence: feeModelSentence(feeMode, feeConfig, bill.currency),
      demoMode: true,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts — start a gift (Amount step). Fee is computed server-side.
router.post('/', requireActive, rateLimit('gift-create', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const { billId, amountMinor, tipMinor } = req.body || {};
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
    }
    const tip = Number(tipMinor) || 0;
    if (!Number.isSafeInteger(tip) || tip < 0 || tip > amountMinor) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Founder tip must be between 0 and the help amount.' } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill is not open for help right now.' } });
    }
    if (bill.user_id === req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot help your own bill.' } });
    }
    const minGift = Number(await db.getSetting('min_gift_minor')) || 1000;
    if (amountMinor < minGift) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `The minimum help amount is ${minGift / 100} ${bill.currency}.` } });
    }
    const remaining = bill.amount_minor - bill.covered_minor;
    if (amountMinor > remaining) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
    }
    const { feeMode, feeConfig } = await feeContext();
    const q = quote(amountMinor, bill.currency, bill.charity === 1, feeMode, feeConfig);
    // Per-helper hourly gift cap (item 334, admin-configurable) with a
    // friendly cooldown message. The IP-based rateLimit above stays.
    const giftHourCap = Number(await db.getSetting('gift_hour_cap')) || 10;
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const hourCount = Number((await db.get(
      'SELECT COUNT(*) AS c FROM gifts WHERE supporter_id = $1 AND created_at >= $2',
      [req.user.id, hourAgo]
    ))?.c || 0);
    if (hourCount >= giftHourCap) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `You have started ${giftHourCap} gifts in the last hour. Take a short break — you can help again soon.`,
        },
      });
    }
    const id = crypto.randomUUID();
    // Anonymous gift (items 374/452): explicit per-gift toggle, falling
    // back to the user's anonDefault preference.
    const anonymous = req.body?.anonymous === true
      ? 1
      : req.body?.anonymous === false
        ? 0
        : (req.user.prefs?.anonDefault ? 1 : 0);
    await db.run(
      `INSERT INTO gifts (id, bill_id, supporter_id, amount_minor, currency, fee_minor, tip_minor,
        status, reference, dispute_note, anonymous, created_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'initiated', '', '', $8, $9, NULL)`,
      [id, bill.id, req.user.id, amountMinor, bill.currency, q.feeMinor, tip, anonymous, nowIso()]
    );
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [id]);
    await logAudit('user', req.user.id, 'gift_created', 'gift', id, { billId: bill.id, amountMinor });
    // First-gift celebration (item 480): the client celebrates when this
    // is the supporter's first-ever gift.
    const priorGifts = Number((await db.get(
      'SELECT COUNT(*) AS c FROM gifts WHERE supporter_id = $1 AND id != $2',
      [req.user.id, id]
    ))?.c || 0);
    res.status(201).json({ gift: publicGift(gift), feeMode: q.feeMode, demoMode: true, firstGift: priorGifts === 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/reveal — Send step: show the recipient's REAL payout
// account (decrypted). Only the gift's supporter, only after the Check step
// (gift exists in initiated/details_shown). Every reveal is audit-logged.
router.post('/:id/reveal', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    if (!['initiated', 'details_shown'].includes(gift.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Payout details cannot be shown for a ${gift.status} gift.` } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill is not open for help right now.' } });
    }
    // Per-helper daily payout-reveal cap (item 335, admin-configurable).
    const revealDayCap = Number(await db.getSetting('reveal_day_cap')) || 20;
    const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
    const revealCount = Number((await db.get(
      `SELECT COUNT(*) AS c FROM audit_logs
       WHERE action = 'payout_revealed' AND actor_id = $1 AND created_at >= $2`,
      [req.user.id, dayAgo]
    ))?.c || 0);
    if (revealCount >= revealDayCap) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `You have viewed payout details ${revealDayCap} times today. Please come back tomorrow.`,
        },
      });
    }
    const { rows } = await db.query('SELECT * FROM payout_methods WHERE bill_id = $1', [bill.id]);
    const methods = rows.map((r) => {
      let account;
      try {
        account = decryptAccount(r.account_enc);
      } catch {
        account = null;
      }
      let meta = {};
      try { meta = JSON.parse(r.meta_json || '{}'); } catch { meta = {}; }
      // bank_in stores "account|IFSC" — split for display.
      let ifsc = meta.ifsc || null;
      if (r.method === 'bank_in' && account && account.includes('|')) {
        [account, ifsc] = account.split('|');
      }
      return {
        method: r.method,
        holderName: r.holder_name,
        account,
        bankName: meta.bankName || null,
        branch: meta.branch || null,
        ifsc,
        hint: r.account_hint,
        link: r.method === 'payment_link' ? account : null,
        qrUrl: r.method === 'fonepay_qr' ? account : null,
      };
    });
    if (gift.status === 'initiated') {
      await db.run(`UPDATE gifts SET status = 'details_shown' WHERE id = $1`, [gift.id]);
    }
    await logAudit('user', req.user.id, 'payout_revealed', 'gift', gift.id, {
      billId: bill.id, recipientId: bill.user_id, methods: rows.map((r) => r.method),
    });
    await createNotification(
      bill.user_id, 'gift_details_shown', 'Someone is about to help',
      `${req.user.displayName} is sending you ${gift.amount_minor / 100} ${gift.currency}.`,
      `#/bill/${bill.id}`
    );
    res.json({
      gift: publicGift({ ...gift, status: 'details_shown' }),
      payoutMethods: methods,
      payDirect: bill.pay_direct === 1 ? {
        billerName: bill.biller_name,
        billerRef: bill.biller_ref,
        billerDestination: bill.biller_destination,
      } : null,
      warning: 'Check the name matches before you send. If it doesn\'t match, don\'t send — report it. Sahay Pay will never ask for your MPIN or OTP.',
      demoMode: true,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/reported-sent — supporter taps "I've sent it".
router.post('/:id/reported-sent', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    if (gift.status !== 'details_shown') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a gift with shown details can be reported sent (current: ${gift.status}).` } });
    }
    const reference = cleanStr(req.body?.reference || '', 120);
    await db.run(`UPDATE gifts SET status = 'donor_reported_sent', reference = $1 WHERE id = $2`, [reference, gift.id]);
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (bill) {
      await createNotification(
        bill.user_id, 'gift_reported_sent', 'Someone says they sent you money',
        `${req.user.displayName} says they sent ${gift.amount_minor / 100} ${gift.currency}${reference ? ` (ref: ${reference})` : ''} — did it arrive?`,
        `#/mybills`
      );
    }
    await logAudit('user', req.user.id, 'gift_reported_sent', 'gift', gift.id, { reference });
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/confirm — RECIPIENT ONLY. Only confirmation moves the
// gift to confirmed, credits the bill (capped), and counts on leaderboards.
router.post('/:id/confirm', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the person who posted the bill can confirm a gift arrived.' } });
    }
    if (gift.status !== 'donor_reported_sent') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a donor-reported gift can be confirmed (current: ${gift.status}).` } });
    }
    const now = nowIso();
    const credit = Math.min(gift.amount_minor, Math.max(0, bill.amount_minor - bill.covered_minor));
    // First confirmed gift? (item 480 — first-gift celebration.)
    const priorConfirmed = Number((await db.get(
      `SELECT COUNT(*) AS c FROM gifts WHERE supporter_id = $1 AND status = 'confirmed'`,
      [gift.supporter_id]
    ))?.c || 0);
    await db.run(`UPDATE gifts SET status = 'confirmed', confirmed_at = $1 WHERE id = $2`, [now, gift.id]);
    await db.run(`UPDATE bills SET covered_minor = covered_minor + $1, updated_at = $2 WHERE id = $3`, [credit, now, bill.id]);
    const updatedBill = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    if (updatedBill.covered_minor >= updatedBill.amount_minor && updatedBill.status === 'approved') {
      await db.run(`UPDATE bills SET status = 'completed', completed_at = $1 WHERE id = $2`, [now, bill.id]);
    }
    await createNotification(
      gift.supporter_id, 'gift_confirmed', 'Your help arrived',
      `${req.user.displayName} confirmed your ${gift.amount_minor / 100} ${gift.currency} help. Thank you — you helped.`,
      `#/bill/${bill.id}`
    );
    await logAudit('user', req.user.id, 'gift_confirmed', 'gift', gift.id, { billId: bill.id, creditedMinor: credit });
    // Tiers + achievements (items 411/415): award lazily on confirm.
    // Best-effort — a failure here must never fail the confirmation.
    let newAchievements = [];
    try { newAchievements = await awardAchievements(gift.supporter_id); } catch { /* best-effort */ }
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({
      gift: publicGift(updated), creditedMinor: credit, billCoveredMinor: updatedBill.covered_minor,
      firstGift: priorConfirmed === 0,
      billCompleted: updatedBill.covered_minor >= updatedBill.amount_minor,
      newAchievements,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/not-received — recipient says it did not arrive.
// The gift STAYS donor-reported (labelled exactly that, never "verified").
router.post('/:id/not-received', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the person who posted the bill can say a gift did not arrive.' } });
    }
    if (gift.status !== 'donor_reported_sent') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a donor-reported gift can be marked not received (current: ${gift.status}).` } });
    }
    const note = cleanStr(req.body?.note || 'Recipient says the gift did not arrive.', 500);
    await db.run(`UPDATE gifts SET dispute_note = $1 WHERE id = $2`, [note, gift.id]);
    await createNotification(
      gift.supporter_id, 'gift_not_received', 'They say your help did not arrive',
      `${req.user.displayName} says the ${gift.amount_minor / 100} ${gift.currency} did not arrive. Check the details and reference, or open a dispute.`,
      `#/mybills`
    );
    await logAudit('user', req.user.id, 'gift_not_received', 'gift', gift.id, {});
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated), note: 'The gift stays donor-reported. Either side can open a dispute for admin review.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/dispute — either side opens a dispute for admin review.
router.post('/:id/dispute', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    const isParty = gift.supporter_id === req.user.id || (bill && bill.user_id === req.user.id);
    if (!isParty) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the supporter or the recipient can dispute this gift.' } });
    if (['confirmed', 'disputed', 'reversed', 'failed'].includes(gift.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${gift.status} gift cannot be disputed.` } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    if (note.length < 5) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please say what went wrong (5+ characters).' } });
    }
    await db.run(`UPDATE gifts SET status = 'disputed', dispute_note = $1 WHERE id = $2`, [note, gift.id]);
    await logAudit('user', req.user.id, 'gift_disputed', 'gift', gift.id, { note });
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated) });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/mine?type=given|received
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const type = req.query.type === 'received' ? 'received' : 'given';
    let rows;
    if (type === 'given') {
      ({ rows } = await db.query(
        `SELECT g.*, b.title AS bill_title, b.request_code AS bill_code, b.status AS bill_status
         FROM gifts g JOIN bills b ON b.id = g.bill_id
         WHERE g.supporter_id = $1 ORDER BY g.created_at DESC LIMIT 100`,
        [req.user.id]
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT g.*, b.title AS bill_title, b.request_code AS bill_code, b.status AS bill_status,
                u.display_name AS supporter_name, u.username AS supporter_username
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
         WHERE b.user_id = $1 ORDER BY g.created_at DESC LIMIT 100`,
        [req.user.id]
      ));
    }
    res.json({
      gifts: rows.map((r) => ({
        ...publicGift(r),
        billTitle: r.bill_title,
        billCode: r.bill_code,
        billStatus: r.bill_status,
        supporterName: r.supporter_name,
        supporterUsername: r.supporter_username,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
