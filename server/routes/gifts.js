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
const { maybeNotifyReferralMilestone } = require('../lib/referrals');

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
    // Item 645: alert the poster that someone started helping (before any
    // money moves — distinct from the confirm / reported-sent alerts).
    await createNotification(
      bill.user_id, 'gift_started', 'Someone started helping',
      `${req.user.displayName} started helping with "${bill.title}" (${amountMinor / 100} ${bill.currency}).`,
      `#/mybills`
    );
    res.status(201).json({ gift: publicGift(gift), feeMode: q.feeMode, demoMode: true });
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
    const coveredBefore = Number(bill.covered_minor || 0);
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
    // --- Phase 2 §7 gift milestones (647–651, 648 first-gift, 674 referral) ---
    const billUrl = `#/bill/${bill.id}`;
    const coveredAfter = Number(updatedBill.covered_minor || 0);
    const total = Number(bill.amount_minor || 0);
    const pctBefore = total > 0 ? (coveredBefore / total) * 100 : 0;
    const pctAfter = total > 0 ? (coveredAfter / total) * 100 : 0;
    // 647: 50% / 75% progress alerts to the poster (crossing each threshold
    // fires exactly once — the before/after comparison is the dedupe).
    if (pctBefore < 50 && pctAfter >= 50 && pctAfter < 100) {
      await createNotification(bill.user_id, 'gift_progress', 'Halfway there!',
        `"${bill.title}" is now ${Math.round(pctAfter)}% funded.`, billUrl);
    } else if (pctBefore < 75 && pctAfter >= 75 && pctAfter < 100) {
      await createNotification(bill.user_id, 'gift_progress', 'Almost there!',
        `"${bill.title}" is now ${Math.round(pctAfter)}% funded.`, billUrl);
    }
    // 648: first-gift alert (first CONFIRMED gift on this bill).
    const confirmedCount = await db.get(
      `SELECT COUNT(*) AS c FROM gifts WHERE bill_id = $1 AND status = 'confirmed'`,
      [bill.id]
    );
    if (Number(confirmedCount?.c || 0) === 1) {
      await createNotification(bill.user_id, 'first_gift', 'Your first help arrived!',
        `${req.user.displayName} confirmed the first help on "${bill.title}".`, billUrl);
    }
    // 651: fully-funded alert to the poster and every confirmed giver.
    if (pctAfter >= 100 && total > 0) {
      await createNotification(bill.user_id, 'gift_fully_funded', 'Fully funded!',
        `"${bill.title}" is fully funded. Thank you to everyone who helped.`, billUrl);
      const { rows: givers } = await db.query(
        `SELECT DISTINCT supporter_id FROM gifts WHERE bill_id = $1 AND status = 'confirmed'`,
        [bill.id]
      );
      for (const g of givers) {
        await createNotification(g.supporter_id, 'gift_fully_funded', 'Fully funded!',
          `"${bill.title}" — a bill you helped — is fully funded.`, billUrl);
      }
    }
    // 649/650: giver milestones (lifetime confirmed total per currency;
    // thresholds 1,000 / 5,000 / 10,000 — same numbers in NPR and INR).
    const giverTotals = await db.get(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total,
              COUNT(DISTINCT bill_id) AS bills
       FROM gifts WHERE supporter_id = $1 AND status = 'confirmed' AND currency = $2`,
      [gift.supporter_id, gift.currency]
    );
    const giverTotalMinor = Number(giverTotals?.total || 0);
    const totalBeforeMinor = giverTotalMinor - gift.amount_minor;
    for (const threshold of [100000, 500000, 1000000]) {
      if (totalBeforeMinor < threshold && giverTotalMinor >= threshold) {
        await createNotification(
          gift.supporter_id, 'milestone_giver', 'Milestone reached!',
          `You have now given ${threshold / 100} ${gift.currency} in total on Sahay Pay. Thank you.`,
          '#/leaderboard'
        );
        break;
      }
    }
    // 650: distinct-bills-helped milestones (5 / 10 / 25 bills).
    const billsHelped = Number(giverTotals?.bills || 0);
    if ([5, 10, 25].includes(billsHelped)) {
      await createNotification(
        gift.supporter_id, 'milestone_helper', `You helped ${billsHelped} bills!`,
        `You have now helped ${billsHelped} different bills on Sahay Pay.`, '#/leaderboard'
      );
    }
    // 674: this supporter's first confirmed gift counts as a referral
    // milestone for whoever invited them (and vice-versa for a first bill).
    await maybeNotifyReferralMilestone(gift.supporter_id, 'first_gift');
    await logAudit('user', req.user.id, 'gift_confirmed', 'gift', gift.id, { billId: bill.id, creditedMinor: credit });
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

module.exports = router;
