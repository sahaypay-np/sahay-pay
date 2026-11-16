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
const { requireAuth, requireActive, rateLimit, rateLimitAccount, rotateSession } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { isMinorAmount } = require('../lib/money');
const { quote, feeModelSentence } = require('../lib/fees');
const { decryptAccount } = require('../lib/storage');
const { createNotification, sendOwnerWebhook } = require('../lib/notify');
const { newChallenge, verifyChallenge } = require('../lib/challenge');
const { deviceClass } = require('../lib/device');
const {
  REVEAL_DAILY_CAP_PER_ACCOUNT,
  REVEAL_DAILY_CAP_PER_BILL,
  countRevealsByUser,
  countRevealsByBill,
  detectRevealAnomaly,
} = require('../lib/security');

const router = express.Router();

// Item 824: a session must be at least 5 minutes old before it may reveal
// payout details (a freshly-stolen or freshly-created session cannot).
const REVEAL_MIN_SESSION_AGE_MS = 5 * 60 * 1000;

const PAYMENT_METHODS = new Set(['esewa', 'khalti', 'connectips', 'bank', 'upi', 'cash', 'other']);

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
    paymentMethod: g.payment_method || null,
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
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO gifts (id, bill_id, supporter_id, amount_minor, currency, fee_minor, tip_minor,
        status, reference, dispute_note, created_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'initiated', '', '', $8, NULL)`,
      [id, bill.id, req.user.id, amountMinor, bill.currency, q.feeMinor, tip, nowIso()]
    );
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [id]);
    await logAudit('user', req.user.id, 'gift_created', 'gift', id, { billId: bill.id, amountMinor });
    res.status(201).json({ gift: publicGift(gift), feeMode: q.feeMode, demoMode: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/:id/challenge — item 847: fetch the simple arithmetic
// challenge that must be answered before a payout reveal. Supporter only.
router.get('/:id/challenge', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    res.json(newChallenge(gift.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/reveal — Send step: show the recipient's REAL payout
// account (decrypted). Only the gift's supporter, only after the Check step
// (gift exists in initiated/details_shown). Every reveal attempt — success,
// failure, or blocked — is audit-logged (item 830).
// Gates, in order: 18+ re-check (809), 5-minute session age (824),
// challenge answer (847), per-account daily cap (828), per-bill daily
// cap (845). On success the session token is rotated (802) and the reveal
// is anomaly-checked (827; unusual-hours anomalies alert the owner, 887).
router.post('/:id/reveal', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', req.params.id, { reason: 'not_found' });
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    // Item 809: re-validate the 18+ age gate server-side before reveal.
    if (Number(req.user.age) < 18) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'age_gate' });
      return res.status(403).json({ error: { code: 'AGE_REQUIRED', message: 'Sahay Pay is for adults only (18+).' } });
    }
    // Item 824: block reveals from sessions created less than 5 minutes ago.
    const sessionAgeMs = req.sessionRow?.created_at ? Date.now() - Date.parse(req.sessionRow.created_at) : Infinity;
    if (sessionAgeMs < REVEAL_MIN_SESSION_AGE_MS) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'session_too_new' });
      return res.status(403).json({
        error: {
          code: 'SESSION_TOO_NEW',
          message: 'For safety, payout details can only be shown a few minutes after you sign in. Please wait a moment and try again.',
        },
      });
    }
    // Item 847: the in-app challenge must be answered first.
    if (!req.body?.challengeId || req.body?.answer === undefined) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'challenge_missing' });
      return res.status(400).json({
        error: { code: 'CHALLENGE_REQUIRED', message: 'Please answer the quick question before the payout details are shown.' },
      });
    }
    if (!verifyChallenge(req.body.challengeId, gift.id, req.body.answer)) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'challenge_failed' });
      return res.status(403).json({
        error: { code: 'CHALLENGE_FAILED', message: 'That answer was not right — please try the question again.' },
      });
    }
    // Item 828: per-account daily cap on payout-reveal views.
    const userReveals = await countRevealsByUser(req.user.id);
    if (userReveals >= REVEAL_DAILY_CAP_PER_ACCOUNT) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'account_daily_cap' });
      return res.status(429).json({
        error: {
          code: 'REVEAL_CAP',
          message: `You have viewed payout details ${REVEAL_DAILY_CAP_PER_ACCOUNT} times today — the daily limit. Please try again tomorrow.`,
        },
      });
    }
    // Item 845: global rate limit on reveals per bill per day.
    const billReveals = await countRevealsByBill(gift.bill_id);
    if (billReveals >= REVEAL_DAILY_CAP_PER_BILL) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'bill_daily_cap' });
      return res.status(429).json({
        error: { code: 'REVEAL_CAP', message: 'This bill\'s payout details have been viewed many times today. Please try again tomorrow.' },
      });
    }
    if (!['initiated', 'details_shown'].includes(gift.status)) {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: `invalid_state:${gift.status}` });
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Payout details cannot be shown for a ${gift.status} gift.` } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (!bill || bill.status !== 'approved') {
      await logAudit('user', req.user.id, 'payout_reveal_blocked', 'gift', gift.id, { reason: 'bill_not_approved' });
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill is not open for help right now.' } });
    }
    const { rows } = await db.query('SELECT * FROM payout_methods WHERE bill_id = $1', [bill.id]);
    const methods = rows.map((r) => {
      let account;
      try {
        account = decryptAccount(r.account_enc, r.method);
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
    const devClass = deviceClass(req.headers['user-agent']);
    // Item 827: anomaly detection (new device / unusual hours) — checked
    // BEFORE this reveal is logged, so "new device" means new vs PRIOR reveals.
    const { anomaly, reasons } = await detectRevealAnomaly(req.user.id, devClass);
    await logAudit('user', req.user.id, 'payout_revealed', 'gift', gift.id, {
      billId: bill.id, recipientId: bill.user_id, methods: rows.map((r) => r.method),
      deviceClass: devClass,
    });
    if (anomaly) {
      await logAudit('user', req.user.id, 'payout_reveal_anomaly', 'gift', gift.id, {
        billId: bill.id, reasons, deviceClass: devClass,
      });
      // Item 887: an anomaly outside normal hours also alerts the owner.
      if (reasons.includes('unusual_hours')) {
        sendOwnerWebhook({
          type: 'reveal_anomaly', giftId: gift.id, billId: bill.id,
          userId: req.user.id, reasons, deviceClass: devClass,
        });
      }
    }
    // Item 802: rotate the session token on this sensitive action.
    await rotateSession(req, res);
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
    // Item 929: record HOW the supporter paid (outside the app).
    const paymentMethod = PAYMENT_METHODS.has(String(req.body?.paymentMethod || ''))
      ? String(req.body.paymentMethod)
      : null;
    await db.run(
      `UPDATE gifts SET status = 'donor_reported_sent', reference = $1, payment_method = $2 WHERE id = $3`,
      [reference, paymentMethod || '', gift.id]
    );
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
// Item 843: per-account rate limit. Item 809: 18+ re-check.
router.post('/:id/confirm', requireActive, rateLimitAccount('gift-confirm', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    if (Number(req.user.age) < 18) {
      return res.status(403).json({ error: { code: 'AGE_REQUIRED', message: 'Sahay Pay is for adults only (18+).' } });
    }
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
    // Item 849: velocity flag — many confirmations in a short window are
    // flagged for admin review (flag only, never a block).
    const recentConfirms = await db.get(
      `SELECT COUNT(*) AS c FROM audit_logs
       WHERE action = 'gift_confirmed' AND actor_id = $1 AND created_at >= $2`,
      [req.user.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()]
    );
    if (Number(recentConfirms?.c || 0) >= 10) {
      await logAudit('system', 'velocity', 'gift_confirm_velocity_flag', 'user', req.user.id, {
        confirmsLastHour: Number(recentConfirms.c),
      });
    }
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated), creditedMinor: credit, billCoveredMinor: updatedBill.covered_minor });
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

// GET /api/gifts/:id — one gift, party-only (supporter or recipient).
// Powers the screenshot-friendly receipt page (item 936). Defined AFTER
// /mine so "mine" is not swallowed as an id.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    const isParty = gift.supporter_id === req.user.id || (bill && bill.user_id === req.user.id);
    if (!isParty) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const supporter = await db.get('SELECT display_name, username FROM users WHERE id = $1', [gift.supporter_id]);
    const recipient = bill ? await db.get('SELECT display_name, username FROM users WHERE id = $1', [bill.user_id]) : null;
    res.json({
      gift: publicGift(gift),
      bill: bill ? { id: bill.id, title: bill.title, requestCode: bill.request_code, status: bill.status } : null,
      supporter: supporter ? { displayName: supporter.display_name, username: supporter.username } : null,
      recipient: recipient ? { displayName: recipient.display_name, username: recipient.username } : null,
      demoMode: true,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/:id/dispute-status — item 938 (standalone part): both
// parties can see the state of a reported payment problem. The admin
// dispute queue itself is §8.754 (outside this workstream) — until it
// lands, disputes show as "waiting for owner review".
router.get('/:id/dispute-status', requireAuth, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    const isParty = gift.supporter_id === req.user.id || (bill && bill.user_id === req.user.id);
    if (!isParty) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const { rows } = await db.query(
      `SELECT action, actor_id, created_at FROM audit_logs
       WHERE target_type = 'gift' AND target_id = $1
         AND action IN ('gift_created', 'payout_revealed', 'gift_reported_sent',
                        'gift_confirmed', 'gift_not_received', 'gift_disputed')
       ORDER BY created_at ASC`,
      [gift.id]
    );
    res.json({
      gift: publicGift(gift),
      bill: bill ? { id: bill.id, title: bill.title, requestCode: bill.request_code } : null,
      disputed: gift.status === 'disputed',
      disputeNote: gift.dispute_note || '',
      timeline: rows.map((r) => ({ action: r.action, actorId: r.actor_id, createdAt: r.created_at })),
      ownerReviewPending: gift.status === 'disputed',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
