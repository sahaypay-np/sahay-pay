// Sahay Pay — gifts routes (the help journey).
// POST /api/gifts/quote, POST /api/gifts, POST /api/gifts/:id/reveal,
// POST /api/gifts/:id/reported-sent, POST /api/gifts/:id/confirm,
// POST /api/gifts/:id/not-received, POST /api/gifts/:id/dispute,
// GET /api/gifts/mine?type=given|received, GET /api/gifts/mine/monthly,
// GET /api/gifts/bill/:billId, GET /api/gifts/:id/receipt,
// GET|POST /api/gifts/:id/messages, POST /api/gifts/:id/fee-review,
// POST /api/gifts/sheet-opened (analytics event).
// Statuses: initiated -> details_shown -> donor_reported_sent -> confirmed.
// 'disputed' pauses credit; 'expired' is the 7-day lazy expiry (item 244).
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
const { quote, feeModelSentence, isFeeExempt, feeExemptReason } = require('../lib/fees');
const { containsBlockedTerm } = require('../lib/message-blocklist');
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
const { runGiftMaintenanceSafe } = require('../lib/gift-maintenance');
const { awardAchievements } = require('../lib/achievements');
const { maybeNotifyReferralMilestone } = require('../lib/referrals');

const router = express.Router();

// Item 824: a session must be at least 5 minutes old before it may reveal
// payout details (a freshly-stolen or freshly-created session cannot).
const REVEAL_MIN_SESSION_AGE_MS = 5 * 60 * 1000;

const PAYMENT_METHODS = new Set(['esewa', 'khalti', 'connectips', 'bank', 'upi', 'cash', 'other']);

// Receipt numbers (item 265): SP-R-XXXXXX, unambiguous alphabet (no 0/O/1/I/L).
const RECEIPT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
async function generateReceiptNumber() {
  for (let i = 0; i < 5; i++) {
    let s = '';
    for (let j = 0; j < 6; j++) s += RECEIPT_ALPHABET[crypto.randomInt(RECEIPT_ALPHABET.length)];
    const num = `SP-R-${s}`;
    const existing = await db.get('SELECT id FROM gifts WHERE receipt_number = $1', [num]);
    if (!existing) return num;
  }
  return `SP-R-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

async function feeContext() {
  const [feeModeRaw, feeConfig, charityFreeCategories, minNprRaw, minInrRaw, minLegacyRaw] =
    await Promise.all([
      db.getSetting('fee_mode'),
      db.getSettingJson('fee_config', {}),
      db.getSettingJson('charity_fee_free_categories', []),
      db.getSetting('min_gift_minor_npr'),
      db.getSetting('min_gift_minor_inr'),
      db.getSetting('min_gift_minor'),
    ]);
  const legacy = Number(minLegacyRaw) || 1000;
  return {
    feeMode: feeModeRaw || 'supporter_fee',
    feeConfig,
    charityFreeCategories: Array.isArray(charityFreeCategories) ? charityFreeCategories : [],
    minGiftMinor: {
      NPR: Number(minNprRaw) || legacy,
      INR: Number(minInrRaw) || legacy,
    },
  };
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
    message: g.message || '',
    anonymous: g.anonymous === 1,
    receiptNumber: g.receipt_number || null,
    detailsShownAt: g.details_shown_at || null,
    reportedSentAt: g.reported_sent_at || null,
    disputedAt: g.disputed_at || null,
    directPay: g.direct_pay === 1,
    billerName: g.biller_name || '',
    billerRef: g.biller_ref || '',
    feeReviewStatus: g.fee_review_status || 'none',
    feeReviewCase: g.fee_review_case || '',
    feeReviewAt: g.fee_review_at || null,
    createdAt: g.created_at,
    confirmedAt: g.confirmed_at,
  };
}

async function loadGiftParty(gift, req) {
  // Returns 'helper' | 'poster' | null for this request. Admin access to
  // threads and receipts goes through the admin dispute routes instead
  // (admin sessions carry no user session, so requireAuth would reject
  // them here).
  const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
  if (gift.supporter_id === req.user?.id) return { role: 'helper', bill };
  if (bill && bill.user_id === req.user?.id) return { role: 'poster', bill };
  return { role: null, bill };
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
    const { feeMode, feeConfig, charityFreeCategories, minGiftMinor } = await feeContext();
    const minGift = minGiftMinor[bill.currency] || 1000;
    if (amountMinor < minGift) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `The minimum help amount is ${minGift / 100} ${bill.currency}.` } });
    }
    const remaining = bill.amount_minor - bill.covered_minor;
    if (amountMinor > remaining) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
    }
    const exempt = isFeeExempt(bill.charity === 1, bill.category, charityFreeCategories);
    const q = quote(amountMinor, bill.currency, bill.charity === 1, feeMode, feeConfig, exempt);
    res.json({
      billId: bill.id,
      amountMinor,
      currency: bill.currency,
      feeMinor: q.feeMinor,
      totalMinor: q.totalMinor,
      feeMode: q.feeMode,
      feeExempt: exempt,
      feeExemptReason: feeExemptReason(bill.charity === 1, bill.category, charityFreeCategories, feeMode),
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
    const { billId, amountMinor, tipMinor, message, directPay, billerRef } = req.body || {};
    // NOTE: `anonymous` is computed below (0/1 with the anonDefault
    // preference fallback, items 374/452) — not destructured here.
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
    }
    const tip = Number(tipMinor) || 0;
    if (!Number.isSafeInteger(tip) || tip < 0 || tip > amountMinor) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Founder tip must be between 0 and the help amount.' } });
    }
    // Gift message (items 256/257): optional, max 200 chars, screened.
    const msg = cleanStr(message || '', 200);
    if (msg && containsBlockedTerm(msg)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'That message contains words we cannot show to the recipient. Please write a kind note instead — no contact details, links or phone numbers.' } });
    }
    const isDirect = directPay === true;
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill is not open for help right now.' } });
    }
    if (bill.user_id === req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot help your own bill.' } });
    }
    if (isDirect && bill.pay_direct !== 1) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'This bill does not offer direct-to-biller payment.' } });
    }
    const { feeMode, feeConfig, charityFreeCategories, minGiftMinor } = await feeContext();
    const minGift = minGiftMinor[bill.currency] || 1000;
    if (amountMinor < minGift) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `The minimum help amount is ${minGift / 100} ${bill.currency}.` } });
    }
    const remaining = bill.amount_minor - bill.covered_minor;
    if (amountMinor > remaining) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
    }
    const exempt = isFeeExempt(bill.charity === 1, bill.category, charityFreeCategories);
    const q = quote(amountMinor, bill.currency, bill.charity === 1, feeMode, feeConfig, exempt);
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
        status, reference, dispute_note, message, anonymous, direct_pay, biller_name, biller_ref,
        created_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'initiated', '', '', $8, $9, $10, $11, $12, $13, NULL)`,
      [id, bill.id, req.user.id, amountMinor, bill.currency, q.feeMinor, tip, msg,
        anonymous, isDirect ? 1 : 0,
        isDirect ? (bill.biller_name || '') : '', isDirect ? cleanStr(billerRef || bill.biller_ref || '', 120) : '',
        nowIso()]
    );
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [id]);
    await logAudit('user', req.user.id, 'gift_created', 'gift', id, { billId: bill.id, amountMinor, directPay: isDirect });
    // Item 645: alert the poster that someone started helping (before any
    // money moves — distinct from the confirm / reported-sent alerts).
    await createNotification(
      bill.user_id, 'gift_started', 'Someone started helping',
      `${req.user.displayName} started helping with "${bill.title}" (${amountMinor / 100} ${bill.currency}).`,
      `#/mybills`
    );
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

// POST /api/gifts/sheet-opened — analytics event (item 297): the helper
// opened the gift sheet for a bill. Logged-in only; anonymous opens are
// not tracked. Audit-logged so the admin dashboard can count it.
router.post('/sheet-opened', requireAuth, rateLimit('gift-sheet-opened', 120, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const billId = cleanStr(req.body?.billId, 64);
    if (!billId) return res.status(400).json({ error: { code: 'VALIDATION', message: 'billId is required.' } });
    await logAudit('user', req.user.id, 'gift_sheet_opened', 'bill', billId, {});
    res.json({ ok: true });
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
      await db.run(`UPDATE gifts SET status = 'details_shown', details_shown_at = $1 WHERE id = $2`, [nowIso(), gift.id]);
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

// POST /api/gifts/:id/reported-sent — supporter taps "I've sent it"
// (or "I paid the biller" for a direct-pay gift).
router.post('/:id/reported-sent', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    // Direct-pay gifts skip the reveal step: they go initiated -> sent.
    const allowed = gift.direct_pay === 1 ? ['initiated', 'details_shown'] : ['details_shown'];
    if (!allowed.includes(gift.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a gift with shown details can be reported sent (current: ${gift.status}).` } });
    }
    const reference = cleanStr(req.body?.reference || '', 120);
    // Item 929: record HOW the supporter paid (outside the app).
    const paymentMethod = PAYMENT_METHODS.has(String(req.body?.paymentMethod || ''))
      ? String(req.body.paymentMethod)
      : null;
    const billerRef = cleanStr(req.body?.billerRef || '', 120);
    await db.run(
      `UPDATE gifts SET status = 'donor_reported_sent', reference = $1, payment_method = $2, reported_sent_at = $3, biller_ref = $4 WHERE id = $5`,
      [reference, paymentMethod || '', nowIso(), billerRef || gift.biller_ref || '', gift.id]
    );
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (bill) {
      await createNotification(
        bill.user_id, 'gift_reported_sent',
        gift.direct_pay === 1 ? 'Someone says they paid your biller' : 'Someone says they sent you money',
        gift.direct_pay === 1
          ? `${req.user.displayName} says they paid ${gift.amount_minor / 100} ${gift.currency} to ${gift.biller_name || 'your biller'}${reference ? ` (ref: ${reference})` : ''} — is the bill settled?`
          : `${req.user.displayName} says they sent ${gift.amount_minor / 100} ${gift.currency}${reference ? ` (ref: ${reference})` : ''} — did it arrive?`,
        `#/mybills`
      );
    }
    await logAudit('user', req.user.id, 'gift_reported_sent', 'gift', gift.id, { reference, directPay: gift.direct_pay === 1 });
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/confirm — RECIPIENT ONLY. Only confirmation moves the
// gift to confirmed, credits the bill (capped), and counts on leaderboards.
// Item 843: per-account rate limit. Item 809: 18+ re-check.
// A Demo Mode receipt number is issued here (item 265).
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
    const coveredBefore = Number(bill.covered_minor || 0);
    const credit = Math.min(gift.amount_minor, Math.max(0, bill.amount_minor - bill.covered_minor));
    // First confirmed gift? (item 480 — first-gift celebration.)
    const priorConfirmed = Number((await db.get(
      `SELECT COUNT(*) AS c FROM gifts WHERE supporter_id = $1 AND status = 'confirmed'`,
      [gift.supporter_id]
    ))?.c || 0);
    const receiptNumber = gift.receipt_number || (await generateReceiptNumber());
    await db.run(
      `UPDATE gifts SET status = 'confirmed', confirmed_at = $1, receipt_number = $2 WHERE id = $3`,
      [now, receiptNumber, gift.id]
    );
    await db.run(`UPDATE bills SET covered_minor = covered_minor + $1, updated_at = $2 WHERE id = $3`, [credit, now, bill.id]);
    const updatedBill = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    if (updatedBill.covered_minor >= updatedBill.amount_minor && updatedBill.status === 'approved') {
      await db.run(`UPDATE bills SET status = 'completed', completed_at = $1 WHERE id = $2`, [now, bill.id]);
    }
    await createNotification(
      gift.supporter_id, 'gift_confirmed', 'Your help arrived',
      `${req.user.displayName} confirmed your ${gift.amount_minor / 100} ${gift.currency} help. Thank you — you helped.`,
      `#/receipt/${gift.id}`
    );
    await logAudit('user', req.user.id, 'gift_confirmed', 'gift', gift.id, { billId: bill.id, creditedMinor: credit, receiptNumber });
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
    // Tiers + achievements (items 411/415): award lazily on confirm.
    // Best-effort — a failure here must never fail the confirmation.
    let newAchievements = [];
    try { newAchievements = await awardAchievements(gift.supporter_id); } catch { /* best-effort */ }
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
// The note opens the dispute message thread (item 242) so both sides can talk.
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
    await db.run(
      `INSERT INTO gift_messages (id, gift_id, sender_type, sender_id, body, created_at) VALUES ($1, $2, 'poster', $3, $4, $5)`,
      [crypto.randomUUID(), gift.id, req.user.id, note, nowIso()]
    );
    await createNotification(
      gift.supporter_id, 'gift_not_received', 'They say your help did not arrive',
      `${req.user.displayName} says the ${gift.amount_minor / 100} ${gift.currency} did not arrive. Check the details and reference, or reply in the dispute thread.`,
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
    if (['confirmed', 'disputed', 'reversed', 'failed', 'expired'].includes(gift.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${gift.status} gift cannot be disputed.` } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    if (note.length < 5) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please say what went wrong (5+ characters).' } });
    }
    const now = nowIso();
    await db.run(`UPDATE gifts SET status = 'disputed', dispute_note = $1, disputed_at = $2 WHERE id = $3`, [note, now, gift.id]);
    const senderType = gift.supporter_id === req.user.id ? 'helper' : 'poster';
    await db.run(
      `INSERT INTO gift_messages (id, gift_id, sender_type, sender_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), gift.id, senderType, req.user.id, note, now]
    );
    await logAudit('user', req.user.id, 'gift_disputed', 'gift', gift.id, { note });
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/fee-review — supporter asks the admin to review the
// Demo Mode fee for one of the three refund-eligible cases (item 280).
// No money moves: this is an admin message flow only.
const FEE_REVIEW_CASES = {
  details_never_shown: 'Payout details were never shown',
  post_removed: 'The post was removed before I could pay',
  details_didnt_work: 'The payout details did not work',
};
router.post('/:id/fee-review', requireActive, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift || gift.supporter_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    }
    const reason = cleanStr(req.body?.case || req.body?.reason || '', 32);
    if (!FEE_REVIEW_CASES[reason]) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Choose one of the three refund-eligible cases: details never shown, post removed, or details did not work.' } });
    }
    if (gift.fee_review_status === 'requested' || gift.fee_review_status === 'acknowledged') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'A fee review is already open for this gift.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const now = nowIso();
    await db.run(
      `UPDATE gifts SET fee_review_status = 'requested', fee_review_case = $1, fee_review_at = $2 WHERE id = $3`,
      [reason, now, gift.id]
    );
    const body = `Fee review requested — ${FEE_REVIEW_CASES[reason]}.${note ? ` ${note}` : ''}`;
    await db.run(
      `INSERT INTO gift_messages (id, gift_id, sender_type, sender_id, body, created_at) VALUES ($1, $2, 'helper', $3, $4, $5)`,
      [crypto.randomUUID(), gift.id, req.user.id, body, now]
    );
    await logAudit('user', req.user.id, 'fee_review_requested', 'gift', gift.id, { case: reason });
    const updated = await db.get('SELECT * FROM gifts WHERE id = $1', [gift.id]);
    res.json({ gift: publicGift(updated) });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/:id/messages — dispute / fee-review thread (item 242).
// Helper or poster only. Senders are shown by role, never by name.
router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const { role } = await loadGiftParty(gift, req);
    if (!role) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the helper or the recipient can read this thread.' } });
    const { rows } = await db.query(
      `SELECT * FROM gift_messages WHERE gift_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [gift.id]
    );
    res.json({
      gift: publicGift(gift),
      role,
      messages: rows.map((r) => ({
        id: r.id, senderType: r.sender_type, body: r.body, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/gifts/:id/messages — post to the thread (helper or poster).
// Admin messages go through POST /api/admin/disputes/:giftId/message.
router.post('/:id/messages', requireActive, rateLimit('gift-message', 30, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const { role, bill } = await loadGiftParty(gift, req);
    if (!role) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the helper or the recipient can message on this gift.' } });
    const body = cleanStr(req.body?.body || '', 1000);
    if (body.length < 1) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Write a message first.' } });
    }
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO gift_messages (id, gift_id, sender_type, sender_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, gift.id, role, req.user.id, body, now]
    );
    // Notify the other side.
    const link = '#/mybills';
    if (role === 'helper' && bill) {
      await createNotification(bill.user_id, 'gift_message', 'New message about your bill', `The helper wrote about their ${gift.amount_minor / 100} ${gift.currency} gift.`, link);
    } else if (role === 'poster') {
      await createNotification(gift.supporter_id, 'gift_message', 'New message about your gift', `The recipient wrote about your ${gift.amount_minor / 100} ${gift.currency} gift.`, link);
    }
    res.status(201).json({ message: { id, senderType: role, body, createdAt: now } });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/:id/receipt — Demo Mode receipt for a confirmed gift
// (items 261/265/278). Helper or poster only. Never includes
// payout details. Direct-pay gifts get the biller variant.
router.get('/:id/receipt', requireAuth, async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const { role, bill } = await loadGiftParty(gift, req);
    if (!role) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the helper or the recipient can see this receipt.' } });
    if (gift.status !== 'confirmed') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'A receipt is issued only once the recipient confirms the gift arrived.' } });
    }
    // Backfill: gifts confirmed before receipts existed have no number.
    let receiptNumber = gift.receipt_number;
    if (!receiptNumber) {
      receiptNumber = await generateReceiptNumber();
      await db.run(`UPDATE gifts SET receipt_number = $1 WHERE id = $2`, [receiptNumber, gift.id]);
    }
    const supporter = await db.get('SELECT display_name FROM users WHERE id = $1', [gift.supporter_id]);
    const recipient = bill ? await db.get('SELECT display_name FROM users WHERE id = $1', [bill.user_id]) : null;
    const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';
    res.json({
      receipt: {
        receiptNumber,
        giftId: gift.id,
        billId: gift.bill_id,
        billTitle: bill?.title || '',
        billRequestCode: bill?.request_code || '',
        amountMinor: gift.amount_minor,
        feeMinor: gift.fee_minor,
        tipMinor: gift.tip_minor,
        totalMinor: gift.amount_minor + gift.fee_minor + gift.tip_minor,
        currency: gift.currency,
        confirmedAt: gift.confirmed_at,
        supporterName: gift.anonymous === 1 ? 'Anonymous' : firstName(supporter?.display_name),
        recipientName: firstName(recipient?.display_name),
        directPay: gift.direct_pay === 1,
        billerName: gift.biller_name || '',
        billerRef: gift.biller_ref || '',
        message: gift.message || '',
        paymentMethod: gift.payment_method || '',
        reference: gift.reference || '',
        demoMode: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/mine?type=given|received
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    // Lazy reminders + 7-day expiry + pledge reminders (243/244/267).
    await runGiftMaintenanceSafe(req.user.id);
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

// GET /api/gifts/mine/monthly — monthly gift summary for helpers (item 264):
// confirmed gifts grouped by month, NPR and INR kept separate.
router.get('/mine/monthly', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT g.*, b.title AS bill_title
       FROM gifts g JOIN bills b ON b.id = g.bill_id
       WHERE g.supporter_id = $1 AND g.status = 'confirmed'
       ORDER BY g.confirmed_at DESC LIMIT 500`,
      [req.user.id]
    );
    const months = {};
    for (const r of rows) {
      const key = `${(r.confirmed_at || r.created_at || '').slice(0, 7)}|${r.currency}`;
      if (!months[key]) {
        months[key] = {
          month: (r.confirmed_at || r.created_at || '').slice(0, 7),
          currency: r.currency, count: 0, totalMinor: 0, feeMinor: 0, tipMinor: 0, gifts: [],
        };
      }
      const m = months[key];
      m.count++;
      m.totalMinor += r.amount_minor;
      m.feeMinor += r.fee_minor;
      m.tipMinor += r.tip_minor;
      m.gifts.push({
        id: r.id, billId: r.bill_id, billTitle: r.bill_title,
        amountMinor: r.amount_minor, feeMinor: r.fee_minor, tipMinor: r.tip_minor,
        receiptNumber: r.receipt_number || null, confirmedAt: r.confirmed_at,
      });
    }
    res.json({ months: Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)) });
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

// GET /api/gifts/bill/:billId — my gifts on one bill (timeline, item 239).
router.get('/bill/:billId', requireAuth, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    const isPoster = bill.user_id === req.user.id;
    const { rows } = await db.query(
      isPoster
        ? `SELECT g.*, u.display_name AS supporter_name FROM gifts g JOIN users u ON u.id = g.supporter_id
           WHERE g.bill_id = $1 ORDER BY g.created_at DESC LIMIT 50`
        : `SELECT g.* FROM gifts g WHERE g.bill_id = $1 AND g.supporter_id = $2 ORDER BY g.created_at DESC LIMIT 50`,
      isPoster ? [bill.id] : [bill.id, req.user.id]
    );
    res.json({
      isPoster,
      gifts: rows.map((r) => ({ ...publicGift(r), supporterName: r.supporter_name })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/gifts/:id/dispute-status — item 938: both parties can see the
// state of a reported payment problem. The timeline includes the §8.754
// admin dispute-queue actions (resolve-confirm / resolve-fail /
// refund-guidance / escalate), so a queue decision shows up here.
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
                        'gift_confirmed', 'gift_not_received', 'gift_disputed',
                        'gift_admin_confirmed', 'dispute_resolved_failed',
                        'dispute_refund_guidance', 'dispute_escalated')
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
