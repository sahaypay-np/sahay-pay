// Sahay Pay — bills routes.
// POST /api/bills (create draft or submit), PATCH /api/bills/:id,
// POST /api/bills/:id/submit, GET /api/bills/mine, POST /api/bills/:id/complete,
// POST /api/bills/:id/remove, POST /api/bills/:id/payout,
// POST /api/uploads (multipart), GET /api/bills/:id (public detail — 404
// unless approved or owner/admin), GET /api/uploads/private/:file.
// Standing rules: nothing public without owner approval; a bill cannot be
// submitted without >=1 valid payout method (unless pay-direct only); a
// material edit to an approved bill sends it back to pending_review.

'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit, lookupAdminSession } = require('../lib/auth');
const {
  cleanStr, validatePayoutMethod, methodAllowedForCountry,
} = require('../lib/validate');
const { parseMajorToMinor, isMinorAmount } = require('../lib/money');
const { upload, isPrivateKind, isKnownKind, publicUrlFor, privateRefFor, encryptAccount, PUBLIC_DIR, PRIVATE_DIR, fileMatchesMime, pathForUploadRef, stripImageMetadata, inspectPhotoOrigin } = require('../lib/storage');
const { createReviewPacket, billPacketPayload, createNotification } = require('../lib/notify');
const { scanScamPhrases, findDuplicateBill } = require('../lib/abuse');
const { findSensitiveNumbers } = require('../lib/sensitive');
const { uaHash } = require('../lib/device');
const { containsBlockedTerm } = require('../lib/message-blocklist');
const { sha256File, averageHash, hammingDistance, AHASH_THRESHOLD } = require('../lib/images');
const { flagSignal, scoreBill } = require('../lib/fraud');
const { tierForCount } = require('../lib/achievements');
const { maybeNotifyReferralMilestone } = require('../lib/referrals');

const router = express.Router();

// Item 870: per-account upload storage quota (50 MB).
const UPLOAD_QUOTA_BYTES = 50 * 1024 * 1024;
// Item 855: per-device posting cap (coarse user-agent hash — a rate-limit
// key, not a device identifier; see server/lib/device.js).
const DEVICE_BILLS_PER_DAY = 10;
// Item 848: velocity flag threshold (bills in the last hour).
const BILL_VELOCITY_PER_HOUR = 5;
// Item 838: payout-edit cooldown.
const PAYOUT_EDIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Item 839: payout edits need a session re-authenticated within 15 min.
const PAYOUT_REAUTH_MINUTES = 15;

const MATERIAL_FIELDS = ['title', 'category', 'amountMinor', 'story', 'details', 'photoUrl', 'photos', 'supportPhotoUrl', 'company', 'charity', 'business', 'dream', 'forWhom', 'payDirect'];

// Phase 2: maximum bill amount (item 107) — NPR/INR 10,00,000 (10 lakh).
const MAX_AMOUNT_MINOR = 100000000;

function generateRequestCode() {
  return `SP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function uniqueRequestCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateRequestCode();
    const existing = await db.get('SELECT id FROM bills WHERE request_code = $1', [code]);
    if (!existing) return code;
  }
  return `SP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

// Ask type (items 191–199): charity > business > dream > plain bill.
// A bill can carry several flags; the first match wins for display/filtering.
function askTypeOf(row) {
  if (row.charity === 1) return 'charity';
  if (row.business === 1) return 'business';
  if (row.dream === 1) return 'dream';
  return 'bill';
}

// Expiry (item 181): 30 days from approval, evaluated LAZILY on read —
// there is no scheduler. Bills approved before expiry existed derive it
// from approved_at; unapproved bills have no expiry.
function expiryOf(row) {
  if (row.expires_at) return row.expires_at;
  if (row.approved_at) return new Date(new Date(row.approved_at).getTime() + 30 * 24 * 3600000).toISOString();
  return null;
}

function isExpired(row, nowMs) {
  if (row.status !== 'approved') return false;
  const exp = expiryOf(row);
  return exp ? new Date(exp).getTime() <= (nowMs || Date.now()) : false;
}

function effectiveStatus(row, nowMs) {
  return isExpired(row, nowMs) ? 'expired' : row.status;
}

function parsePhotos(row) {
  try {
    const arr = JSON.parse(row.photos_json || '[]');
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function publicBill(row, poster, maskPoster) {
  // Anonymous posts hide the poster's identity from everyone except the owner
  // and the admin (callers pass maskPoster=false for those views).
  const anonymous = row.anonymous === 1;
  const shownPoster = poster
    ? anonymous && maskPoster
      ? { displayName: 'Anonymous', username: null, photoUrl: null, city: poster.city, country: poster.country, memberSince: null }
      : {
          displayName: poster.display_name,
          username: poster.username,
          photoUrl: poster.photo_url,
          city: poster.city,
          country: poster.country,
          memberSince: poster.created_at,
        }
    : undefined;
  const expiresAt = expiryOf(row);
  const expired = isExpired(row);
  const photos = parsePhotos(row);
  return {
    id: row.id,
    requestCode: row.request_code,
    title: row.title,
    category: row.category,
    company: row.company,
    amountMinor: row.amount_minor,
    coveredMinor: row.covered_minor,
    currency: row.currency,
    dueDate: row.due_date,
    story: row.story,
    details: row.details,
    charity: row.charity === 1,
    charityName: row.charity_name || '',
    business: row.business === 1,
    businessName: row.business_name || '',
    businessDesc: row.business_desc || '',
    dream: row.dream === 1,
    dreamDesc: row.dream_desc || '',
    askType: askTypeOf(row),
    anonymous,
    status: effectiveStatus(row),
    storedStatus: row.status,
    city: row.city,
    country: row.country,
    photoUrl: row.photo_url,
    photos: photos.length ? photos : (row.photo_url ? [row.photo_url] : []),
    supportPhotoUrl: row.support_photo_url,
    payDirect: row.pay_direct === 1,
    billerName: row.biller_name,
    billerRef: row.biller_ref,
    billerDestination: row.biller_destination,
    billerInstructions: row.biller_instructions || '',
    forWhom: row.for_whom || 'myself',
    relationship: row.relationship || '',
    aboutMe: row.about_me || '',
    storyLang: row.story_lang || 'en',
    notPaidConsequence: row.not_paid_consequence || '',
    triedToPay: row.tried_to_pay || '',
    moneyMeans: row.money_means || '',
    billTypeOther: row.bill_type_other || '',
    expiresAt,
    expired,
    daysLeft: expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000)) : null,
    extensionUsed: row.extension_used === 1,
    repostCount: Number(row.repost_count) || 0,
    views: row.views,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    poster: shownPoster,
  };
}

// Validate + store payout methods for a bill. Returns {ok, hints} or {ok:false, error}.
// Each method is validated server-side and the account is AES-256-GCM encrypted.
async function storePayoutMethods(billId, methods, country) {
  const hints = [];
  for (const m of methods || []) {
    const method = cleanStr(m.method, 32);
    if (!methodAllowedForCountry(method, country)) {
      return { ok: false, error: `Payout method ${method} is not available for ${country === 'NP' ? 'Nepal' : 'India'}.` };
    }
    const v = validatePayoutMethod(m);
    if (!v.ok) return { ok: false, error: v.error };
    await db.run(
      `INSERT INTO payout_methods (id, bill_id, method, holder_name, account_enc, account_hint, meta_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), billId, method, cleanStr(m.holderName, 120), encryptAccount(v.account, method), v.hint, JSON.stringify(v.meta || {}), nowIso()]
    );
    hints.push(v.hint);
  }
  return { ok: true, hints };
}

async function getPayoutHints(billId) {
  const { rows } = await db.query('SELECT method, account_hint FROM payout_methods WHERE bill_id = $1', [billId]);
  return rows.map((r) => ({ method: r.method, hint: r.account_hint }));
}

// Pre-publish privacy scan (item 367): patterns that look like exposed
// personal details in free text. Warns — never blocks — and returns the
// matched kinds so the poster can fix them before submitting.
const PRIVACY_PATTERNS = [
  { kind: 'phone', re: /\b(?:\+?977[- ]?)?9[678]\d{8}\b/ },
  { kind: 'phone', re: /\b\d{10}\b/ },
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { kind: 'account', re: /\b\d{12,20}\b/ },
  { kind: 'account', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
];

function scanPrivacy(text) {
  const found = new Set();
  const hay = String(text || '');
  for (const p of PRIVACY_PATTERNS) {
    if (p.re.test(hay)) found.add(p.kind);
  }
  return [...found];
}

function validateBillFields(body, categories) {
  const title = cleanStr(body.title, 60);
  if (title.length < 3) return { error: 'Please give your request a title (3–60 characters).' };
  if (!categories.includes(body.category)) return { error: 'Please choose a valid category.' };
  const story = cleanStr(body.story, 280);
  if (story.length < 10) return { error: 'Please tell your story (at least 10 characters, max 280).' };
  const amountMinor = typeof body.amountMinor === 'number'
    ? body.amountMinor
    : parseMajorToMinor(body.amount);
  if (!isMinorAmount(amountMinor)) return { error: 'Please enter a valid amount greater than zero.' };
  if (amountMinor > MAX_AMOUNT_MINOR) return { error: 'The maximum bill amount is रू/₹ 10,00,000.' };
  const details = cleanStr(body.details || '', 1500);
  const company = cleanStr(body.company || '', 120);
  return { ok: true, title, story, details, company, amountMinor };
}

// Clean + validate the optional phase-2 fields shared by POST and PATCH.
function cleanExtraFields(body) {
  const forWhom = ['myself', 'family', 'other'].includes(body.forWhom) ? body.forWhom : 'myself';
  const photos = Array.isArray(body.photos)
    ? body.photos.map((u) => cleanStr(u, 500)).filter(Boolean).slice(0, 4)
    : null;
  return {
    forWhom,
    relationship: cleanStr(body.relationship || '', 80),
    forOtherConsent: body.forOtherConsent === true ? 1 : 0,
    aboutMe: cleanStr(body.aboutMe || '', 500),
    billerInstructions: cleanStr(body.billerInstructions || '', 600),
    photos,
    storyLang: ['en', 'ne', 'hi'].includes(body.storyLang) ? body.storyLang : 'en',
    notPaidConsequence: cleanStr(body.notPaidConsequence || '', 300),
    triedToPay: cleanStr(body.triedToPay || '', 300),
    moneyMeans: cleanStr(body.moneyMeans || '', 300),
    billTypeOther: cleanStr(body.billTypeOther || '', 120),
    charityName: cleanStr(body.charityName || '', 120),
    business: body.business === true ? 1 : 0,
    businessName: cleanStr(body.businessName || '', 120),
    businessDesc: cleanStr(body.businessDesc || '', 500),
    dream: body.dream === true ? 1 : 0,
    dreamDesc: cleanStr(body.dreamDesc || '', 500),
  };
}

// POST /api/bills — create a draft, or create + submit when submit=true.
router.post('/', requireActive, rateLimit('post-bill', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    // Item 846: honeypot — the form carries a hidden "website" field no
    // human ever sees; bots fill it. Reject those submissions outright.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Submission rejected.' } });
    }
    const categories = await db.getSettingJson('categories', []);
    const v = validateBillFields(body, categories);
    if (v.error) return res.status(400).json({ error: { code: 'VALIDATION', message: v.error } });

    // Day/week posting caps (item 333, admin-configurable). The hourly
    // rateLimit above stays as the first line of defence.
    const dayCap = Number(await db.getSetting('bill_day_cap')) || 5;
    const weekCap = Number(await db.getSetting('bill_week_cap')) || 10;
    const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const dayCount = Number((await db.get(
      'SELECT COUNT(*) AS c FROM bills WHERE user_id = $1 AND created_at >= $2', [req.user.id, dayAgo]
    ))?.c || 0);
    if (dayCount >= dayCap) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `You can post ${dayCap} bills a day. Please try again tomorrow.` } });
    }
    const weekCount = Number((await db.get(
      'SELECT COUNT(*) AS c FROM bills WHERE user_id = $1 AND created_at >= $2', [req.user.id, weekAgo]
    ))?.c || 0);
    if (weekCount >= weekCap) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `You can post ${weekCap} bills a week. Please try again next week.` } });
    }

    const currency = req.user.country === 'IN' ? 'INR' : 'NPR';
    const submit = body.submit === true;
    const payDirect = body.payDirect === true;
    const methods = Array.isArray(body.payoutMethods) ? body.payoutMethods : [];

    // A bill cannot be submitted without >=1 valid payout method (unless pay-direct only).
    if (submit && !payDirect && methods.length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Add at least one way for supporters to pay you — e.g. your eSewa number, Khalti number, UPI ID or bank details.' },
      });
    }
    // Item 920: separate consent before payout details are collected.
    if (submit && !payDirect && methods.length > 0 && body.payoutConsent !== true) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Please confirm you understand your payout details are encrypted and shown publicly only as a masked hint.' },
      });
    }
    // Item 855: per-device posting cap (coarse UA hash).
    if (submit) {
      const fp = uaHash(req.headers['user-agent']);
      const deviceBills = await db.get(
        `SELECT COUNT(*) AS c FROM bills b JOIN users u ON u.id = b.user_id
         WHERE u.ua_hash = $1 AND b.created_at >= $2`,
        [fp, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
      );
      if (Number(deviceBills?.c || 0) >= DEVICE_BILLS_PER_DAY) {
        return res.status(429).json({
          error: { code: 'DEVICE_LIMIT', message: 'Too many bills were posted from this device today. Please try again tomorrow.' },
        });
      }
    }
    if (submit && payDirect && (!cleanStr(body.billerName, 120) || !cleanStr(body.billerDestination, 500))) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Pay-direct bills need the biller name and the official payment destination from the bill.' },
      });
    }

    const id = crypto.randomUUID();
    const now = nowIso();
    const status = submit ? 'pending_review' : 'draft';
    const extra = cleanExtraFields(body);
    const photoUrl = body.photoUrl ? cleanStr(body.photoUrl, 500) : (extra.photos && extra.photos[0]) || null;
    // Document hash + average hash of the bill photo (items 324/338),
    // computed server-side from the stored file.
    let docHash = null;
    let ahash = null;
    if (photoUrl) {
      const diskPath = pathForUploadRef(photoUrl);
      if (diskPath) {
        try { docHash = sha256File(diskPath); } catch { /* absent */ }
        try { ahash = averageHash(diskPath); } catch { /* PNG-only; null otherwise */ }
      }
    }
    await db.run(
      `INSERT INTO bills (id, user_id, request_code, title, category, company, amount_minor, currency,
        covered_minor, due_date, story, details, charity, anonymous, status, city, country, photo_url,
        support_photo_url, private_proof_url, pay_direct, biller_name, biller_ref, biller_destination,
        views, report_count, rejection_reason, changes_note, approved_at, approved_by, completed_at,
        for_whom, relationship, for_other_consent, about_me, biller_instructions, photos_json,
        story_lang, not_paid_consequence, tried_to_pay, money_means, bill_type_other, charity_name,
        business, business_name, business_desc, dream, dream_desc,
        payout_consent_at, doc_hash, ahash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 0, 0, '', '', NULL, NULL, NULL, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45)`,
      [
        id, req.user.id, await uniqueRequestCode(), v.title, body.category, v.company,
        v.amountMinor, currency, body.dueDate ? cleanStr(body.dueDate, 10) : null,
        v.story, v.details, body.charity === true ? 1 : 0, body.anonymous === true ? 1 : 0, status,
        cleanStr(body.city || req.user.city, 120), req.user.country,
        photoUrl,
        body.supportPhotoUrl ? cleanStr(body.supportPhotoUrl, 500) : null,
        body.privateProofUrl ? cleanStr(body.privateProofUrl, 500) : null,
        payDirect ? 1 : 0,
        cleanStr(body.billerName || '', 120),
        cleanStr(body.billerRef || '', 120),
        cleanStr(body.billerDestination || '', 500),
        extra.forWhom, extra.relationship, extra.forOtherConsent, extra.aboutMe,
        extra.billerInstructions, JSON.stringify(extra.photos || (photoUrl ? [photoUrl] : [])),
        extra.storyLang, extra.notPaidConsequence, extra.triedToPay, extra.moneyMeans,
        extra.billTypeOther, extra.charityName,
        extra.business, extra.businessName, extra.businessDesc, extra.dream, extra.dreamDesc,
        body.payoutConsent === true ? now : null,
        docHash, ahash,
        now, now,
      ]
    );

    const stored = await storePayoutMethods(id, methods, req.user.country);
    if (!stored.ok) {
      await db.run('DELETE FROM bills WHERE id = $1', [id]);
      return res.status(400).json({ error: { code: 'VALIDATION', message: stored.error } });
    }

    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [id]);
    let packet = null;
    // Abuse signals (flags for the human reviewer, never auto-blocks):
    // 853 scam phrases, 854 duplicate bill, 848 velocity, 866/867
    // sensitive numbers in the text, 856 web-download photo flag.
    const scamPhrases = scanScamPhrases(`${v.title} ${v.story} ${v.details}`);
    const sensitiveNumbers = findSensitiveNumbers(`${v.title} ${v.story} ${v.details}`);
    const duplicateOf = await findDuplicateBill({
      title: v.title, amountMinor: v.amountMinor,
      photoUrl: bill.photo_url, excludeBillId: id,
    });
    const photoFlags = body.photoFlags && typeof body.photoFlags === 'object' ? body.photoFlags : null;
    let velocityFlag = false;
    if (submit) {
      const recent = await db.get(
        `SELECT COUNT(*) AS c FROM bills WHERE user_id = $1 AND created_at >= $2`,
        [req.user.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()]
      );
      velocityFlag = Number(recent?.c || 0) >= BILL_VELOCITY_PER_HOUR;
      if (velocityFlag) {
        await logAudit('system', 'velocity', 'bill_velocity_flag', 'user', req.user.id, { billsLastHour: Number(recent.c) });
      }
    }
    if (submit) {
      const payload = await billPacketPayload(bill, await getPayoutHints(id));
      payload.flags = {
        scamPhrases: scamPhrases.length ? scamPhrases : undefined,
        duplicateOf: duplicateOf || undefined,
        velocityFlag: velocityFlag || undefined,
        sensitiveNumbers: sensitiveNumbers.length ? sensitiveNumbers : undefined,
        photoWebDownloadSuspected: photoFlags?.webDownloadSuspected === true || undefined,
        photoSoftware: photoFlags?.software || undefined,
      };
      packet = await createReviewPacket('bill', id, payload);
      await logAudit('user', req.user.id, 'bill_submitted', 'bill', id, { requestCode: bill.request_code });
      // Item 674: the user's first submitted bill counts as a referral
      // milestone for whoever invited them.
      await maybeNotifyReferralMilestone(req.user.id, 'first_bill');
    }
    // Duplicate-bill detector (items 336/337): same biller reference +
    // amount, or same biller name + amount within 30 days, on another
    // live bill. Flags for review — never blocks the submit.
    let duplicateAlert = null;
    if (submit && (bill.biller_ref || bill.biller_name)) {
      const dup = await db.get(
        `SELECT id, title FROM bills WHERE id != $1 AND status IN ('approved','pending_review')
         AND amount_minor = $2 AND biller_name = $3 AND biller_ref = $4
         AND created_at >= $5 LIMIT 1`,
        [id, bill.amount_minor, bill.biller_name || '', bill.biller_ref || '', new Date(Date.now() - 30 * 86400000).toISOString()]
      );
      if (dup) {
        duplicateAlert = { billId: dup.id, title: dup.title };
        await flagSignal({
          billId: id, userId: req.user.id, signal: 'duplicate_bill',
          detail: `Same biller + amount as bill ${dup.id} ("${dup.title}").`, severity: 'high',
        });
      }
    }
    // Image-similarity check (item 338): compare the new photo's aHash
    // against other live bills' photos (PNG only; exact SHA-256 matches
    // are caught by the doc_hash comparison in the admin queue).
    if (submit && ahash) {
      const others = await db.query(
        `SELECT id, title, ahash FROM bills WHERE id != $1 AND ahash IS NOT NULL
         AND status IN ('approved','pending_review') LIMIT 500`,
        [id]
      );
      for (const o of others.rows) {
        if (hammingDistance(ahash, o.ahash) <= AHASH_THRESHOLD) {
          await flagSignal({
            billId: id, userId: req.user.id, signal: 'similar_image',
            detail: `Bill photo closely matches bill ${o.id} ("${o.title}").`, severity: 'high',
          });
          break;
        }
      }
    }
    // Score the bill for the admin queue (item 331) — best-effort.
    let risk = null;
    try { risk = await scoreBill(bill); } catch { /* scoring never blocks */ }
    // Privacy scan warnings (item 367) — informational only.
    const privacyWarnings = scanPrivacy(`${v.title}\n${v.story}\n${v.details}`);
    res.status(201).json({
      bill: publicBill(bill, req.user),
      payoutHints: stored.hints,
      reviewPacketId: packet ? packet.id : null,
      // 866/867: tell the poster what was found so they can redact it.
      sensitiveWarning: sensitiveNumbers.length ? sensitiveNumbers : undefined,
      scamWarning: scamPhrases.length ? scamPhrases : undefined,
      duplicateAlert,
      privacyWarnings,
      riskBand: risk ? risk.band : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bills/mine — own bills, any status (owner-only visibility).
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [req.user.id];
    let where = 'user_id = $1';
    // 'expired' is a derived (lazy) status, not a stored one — filter in JS.
    if (status && status !== 'expired') { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT b.*,
              (SELECT COUNT(*) FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed') AS supporter_count
       FROM bills b WHERE ${where} ORDER BY b.created_at DESC LIMIT 100`,
      params
    );
    const bills = [];
    for (const r of rows) {
      const b = publicBill(r, req.user);
      if (status === 'expired' && b.status !== 'expired') continue;
      if (status === 'approved' && b.status === 'expired') continue;
      b.supporterCount = Number(r.supporter_count);
      b.payoutHints = await getPayoutHints(r.id);
      b.rejectionReason = r.rejection_reason;
      b.changesNote = r.changes_note;
      bills.push(b);
    }
    res.json({ bills });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/submit — move a draft / changes_requested bill to review.
router.post('/:id/submit', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (!['draft', 'changes_requested', 'rejected'].includes(bill.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill cannot be submitted.` } });
    }
    const hints = await getPayoutHints(bill.id);
    if (bill.pay_direct !== 1 && hints.length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Add at least one valid payout method before submitting.' },
      });
    }
    await db.run(
      `UPDATE bills SET status = 'pending_review', rejection_reason = '', changes_note = '', updated_at = $1 WHERE id = $2`,
      [nowIso(), bill.id]
    );
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    const packet = await createReviewPacket('bill', bill.id, await billPacketPayload(updated, hints));
    await logAudit('user', req.user.id, 'bill_submitted', 'bill', bill.id, { requestCode: bill.request_code });
    res.json({ bill: publicBill(updated, req.user), reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bills/:id — edit. A material edit to an APPROVED bill sends it
// back to pending_review (a previous approval never carries over).
router.patch('/:id', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (['completed', 'removed', 'expired'].includes(bill.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill cannot be edited.` } });
    }
    const body = req.body || {};
    const categories = await db.getSettingJson('categories', []);
    const extra = cleanExtraFields(body);
    const fieldMap = {
      title: (v) => cleanStr(v, 60),
      category: (v) => v,
      amountMinor: (v) => v,
      story: (v) => cleanStr(v, 280),
      details: (v) => cleanStr(v, 1500),
      photoUrl: (v) => cleanStr(v, 500),
      photos: () => JSON.stringify(extra.photos || []),
      supportPhotoUrl: (v) => cleanStr(v, 500),
      privateProofUrl: (v) => cleanStr(v, 500),
      company: (v) => cleanStr(v, 120),
      dueDate: (v) => cleanStr(v, 10),
      charity: (v) => (v === true ? 1 : 0),
      charityName: () => extra.charityName,
      business: (v) => (v === true ? 1 : 0),
      businessName: () => extra.businessName,
      businessDesc: () => extra.businessDesc,
      dream: (v) => (v === true ? 1 : 0),
      dreamDesc: () => extra.dreamDesc,
      anonymous: (v) => (v === true ? 1 : 0),
      payDirect: (v) => (v === true ? 1 : 0),
      billerName: (v) => cleanStr(v, 120),
      billerRef: (v) => cleanStr(v, 120),
      billerDestination: (v) => cleanStr(v, 500),
      billerInstructions: () => extra.billerInstructions,
      forWhom: () => extra.forWhom,
      relationship: () => extra.relationship,
      aboutMe: () => extra.aboutMe,
      storyLang: () => extra.storyLang,
      notPaidConsequence: () => extra.notPaidConsequence,
      triedToPay: () => extra.triedToPay,
      moneyMeans: () => extra.moneyMeans,
      billTypeOther: () => extra.billTypeOther,
    };
    const colMap = {
      title: 'title', category: 'category', amountMinor: 'amount_minor', story: 'story',
      details: 'details', photoUrl: 'photo_url', photos: 'photos_json', supportPhotoUrl: 'support_photo_url',
      privateProofUrl: 'private_proof_url',
      company: 'company', dueDate: 'due_date', charity: 'charity', charityName: 'charity_name',
      business: 'business', businessName: 'business_name', businessDesc: 'business_desc',
      dream: 'dream', dreamDesc: 'dream_desc',
      anonymous: 'anonymous', payDirect: 'pay_direct',
      billerName: 'biller_name', billerRef: 'biller_ref', billerDestination: 'biller_destination',
      billerInstructions: 'biller_instructions', forWhom: 'for_whom', relationship: 'relationship',
      aboutMe: 'about_me', storyLang: 'story_lang', notPaidConsequence: 'not_paid_consequence',
      triedToPay: 'tried_to_pay', moneyMeans: 'money_means', billTypeOther: 'bill_type_other',
    };
    const updates = [];
    const params = [];
    let material = false;
    const changedFields = [];
    for (const [key, fn] of Object.entries(fieldMap)) {
      if (body[key] === undefined) continue;
      const value = fn(body[key]);
      if (key === 'category' && !categories.includes(value)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose a valid category.' } });
      }
      if (key === 'amountMinor' && !isMinorAmount(value)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
      }
      if (key === 'amountMinor' && value > MAX_AMOUNT_MINOR) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'The maximum bill amount is रू/₹ 10,00,000.' } });
      }
      if (key === 'title' && value.length < 3) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title must be 3–60 characters.' } });
      }
      if (key === 'story' && value.length < 10) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Story must be at least 10 characters.' } });
      }
      params.push(value);
      updates.push(`${colMap[key]} = $${params.length}`);
      changedFields.push(key);
      if (MATERIAL_FIELDS.includes(key)) material = true;
    }
    if (!updates.length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update.' } });
    }

    let packet = null;
    let backToReview = false;
    if (bill.status === 'approved' && material) {
      updates.push(`status = 'pending_review'`);
      updates.push(`approved_at = NULL`);
      backToReview = true;
    }
    params.push(nowIso());
    updates.push(`updated_at = $${params.length}`);
    params.push(bill.id);
    await db.run(`UPDATE bills SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    // Edit history (item 180): what changed, when. Best-effort — never
    // fails the edit itself.
    try {
      await db.run(
        `INSERT INTO bill_edits (id, bill_id, user_id, changed_fields, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), bill.id, req.user.id, JSON.stringify(changedFields), nowIso()]
      );
    } catch { /* history is advisory */ }
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    if (backToReview) {
      packet = await createReviewPacket('bill', bill.id, await billPacketPayload(updated, await getPayoutHints(bill.id)));
      await logAudit('user', req.user.id, 'bill_material_edit', 'bill', bill.id, { backToReview: true });
    }
    res.json({
      bill: publicBill(updated, req.user),
      backToReview,
      reviewPacketId: packet ? packet.id : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bills/:id/history — edit history (item 180), owner only.
router.get('/:id/history', requireAuth, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    const { rows } = await db.query(
      'SELECT * FROM bill_edits WHERE bill_id = $1 ORDER BY created_at DESC LIMIT 50',
      [bill.id]
    );
    // Item 704: include the review decisions + reasons alongside edits
    // (from the audit log — approve/reject/changes on this bill's packets).
    const { rows: reviewRows } = await db.query(
      `SELECT * FROM audit_logs WHERE target_type = 'bill' AND target_id = $1
       AND action IN ('review_approve', 'review_reject', 'review_changes')
       ORDER BY created_at DESC LIMIT 50`,
      [bill.id]
    );
    res.json({
      edits: rows.map((r) => {
        let fields = [];
        try { fields = JSON.parse(r.changed_fields || '[]'); } catch { /* keep [] */ }
        return { id: r.id, changedFields: fields, createdAt: r.created_at };
      }),
      reviews: reviewRows.map((r) => {
        let meta = {};
        try { meta = JSON.parse(r.meta_json || '{}'); } catch { /* keep {} */ }
        return {
          id: r.id,
          action: r.action,
          reason: meta.reason || '',
          decidedAt: r.created_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/extend — one 14-day expiry extension per bill (item 184).
router.post('/:id/extend', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (bill.status !== 'approved' || isExpired(bill)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only a live approved bill can be extended.' } });
    }
    if (bill.extension_used === 1) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill already used its one 14-day extension.' } });
    }
    const current = expiryOf(bill) || new Date(Date.now() + 30 * 24 * 3600000).toISOString();
    const next = new Date(new Date(current).getTime() + 14 * 24 * 3600000).toISOString();
    await db.run(
      `UPDATE bills SET expires_at = $1, extension_used = 1, updated_at = $2 WHERE id = $3`,
      [next, nowIso(), bill.id]
    );
    await logAudit('user', req.user.id, 'bill_extended', 'bill', bill.id, { expiresAt: next });
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    res.json({ bill: publicBill(updated, req.user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/repost — resubmit an expired bill for review (item 186).
// Limit 3 reposts per bill (item 190).
router.post('/:id/repost', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (!isExpired(bill) && bill.status !== 'expired') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only an expired bill can be reposted.' } });
    }
    if ((Number(bill.repost_count) || 0) >= 3) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This bill has reached the limit of 3 reposts.' } });
    }
    const hints = await getPayoutHints(bill.id);
    if (bill.pay_direct !== 1 && hints.length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Add at least one valid payout method before reposting.' },
      });
    }
    await db.run(
      `UPDATE bills SET status = 'pending_review', expires_at = NULL, extension_used = 0,
       repost_count = repost_count + 1, rejection_reason = '', changes_note = '', updated_at = $1 WHERE id = $2`,
      [nowIso(), bill.id]
    );
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    const packet = await createReviewPacket('bill', bill.id, await billPacketPayload(updated, hints));
    await logAudit('user', req.user.id, 'bill_reposted', 'bill', bill.id, { repostCount: (Number(bill.repost_count) || 0) + 1 });
    res.json({ bill: publicBill(updated, req.user), reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/complete — owner marks their bill completed.
router.post('/:id/complete', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (bill.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill cannot be completed.` } });
    }
    await db.run(`UPDATE bills SET status = 'completed', completed_at = $1, updated_at = $3 WHERE id = $2`, [nowIso(), bill.id, nowIso()]);
    await logAudit('user', req.user.id, 'bill_completed', 'bill', bill.id, {});
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    res.json({ bill: publicBill(updated, req.user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/remove — owner removes their bill (soft: status removed).
router.post('/:id/remove', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    await db.run(`UPDATE bills SET status = 'removed', updated_at = $1 WHERE id = $2`, [nowIso(), bill.id]);
    // Item 840: deleting the bill also deletes its encrypted payout rows
    // (the account numbers must not outlive the bill).
    const deleted = await db.run('DELETE FROM payout_methods WHERE bill_id = $1', [bill.id]);
    await logAudit('user', req.user.id, 'bill_removed', 'bill', bill.id, {
      payoutRowsDeleted: deleted.changes || 0,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/payout — replace payout methods. Changing the payout
// account on a LIVE bill pauses it (back to pending_review) until re-approved.
// Item 839: requires a session re-authenticated (recovery code) within the
// last 15 minutes. Item 838: 24-hour cooldown between edits. Item 837: the
// bill owner is notified of the change.
router.post('/:id/payout', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (['completed', 'removed', 'expired'].includes(bill.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill cannot change payout details.` } });
    }
    const reauthedAt = req.sessionRow?.reauthed_at;
    if (!reauthedAt || Date.now() - Date.parse(reauthedAt) > PAYOUT_REAUTH_MINUTES * 60 * 1000) {
      return res.status(403).json({
        error: {
          code: 'REAUTH_REQUIRED',
          message: 'Changing payout details needs a fresh identity check — please confirm with your recovery code first.',
        },
      });
    }
    if (bill.payout_edited_at && Date.now() - Date.parse(bill.payout_edited_at) < PAYOUT_EDIT_COOLDOWN_MS) {
      return res.status(409).json({
        error: {
          code: 'PAYOUT_COOLDOWN',
          message: 'Payout details can only be changed once every 24 hours. Please try again tomorrow.',
        },
      });
    }
    const methods = Array.isArray(req.body.payoutMethods) ? req.body.payoutMethods : [];
    if (bill.pay_direct !== 1 && methods.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'At least one payout method is required.' } });
    }
    // Validate everything BEFORE deleting the old methods.
    const validated = [];
    for (const m of methods) {
      const method = cleanStr(m.method, 32);
      if (!methodAllowedForCountry(method, bill.country)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `Payout method ${method} is not available for this bill's country.` } });
      }
      const v = validatePayoutMethod(m);
      if (!v.ok) return res.status(400).json({ error: { code: 'VALIDATION', message: v.error } });
      validated.push({ method, holderName: cleanStr(m.holderName, 120), account: v.account, hint: v.hint, meta: v.meta || {} });
    }
    await db.run('DELETE FROM payout_methods WHERE bill_id = $1', [bill.id]);
    for (const v of validated) {
      await db.run(
        `INSERT INTO payout_methods (id, bill_id, method, holder_name, account_enc, account_hint, meta_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [crypto.randomUUID(), bill.id, v.method, v.holderName, encryptAccount(v.account, v.method), v.hint, JSON.stringify(v.meta), nowIso()]
      );
    }
    await db.run('UPDATE bills SET payout_edited_at = $1 WHERE id = $2', [nowIso(), bill.id]);
    let packet = null;
    let backToReview = false;
    if (bill.status === 'approved') {
      await db.run(`UPDATE bills SET status = 'pending_review', approved_at = NULL, updated_at = $1 WHERE id = $2`, [nowIso(), bill.id]);
      const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
      packet = await createReviewPacket('bill', bill.id, await billPacketPayload(updated, await getPayoutHints(bill.id)));
      backToReview = true;
    }
    await logAudit('user', req.user.id, 'bill_payout_changed', 'bill', bill.id, { backToReview });
    await createNotification(
      bill.user_id, 'payout_changed', 'Your payout details were changed',
      `The payout details on "${bill.title}" were changed just now. If that was not you, change them back and contact the owner via the Help Centre.`,
      '#/mybills'
    );
    // Rapid-edit alert (item 341): 2+ payout changes in 24h flags the bill.
    const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
    const editCount = Number((await db.get(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'bill_payout_changed' AND target_id = $1 AND created_at >= $2`,
      [bill.id, dayAgo]
    ))?.c || 0);
    if (editCount >= 2) {
      await flagSignal({
        billId: bill.id, userId: req.user.id, signal: 'rapid_payout_edits',
        detail: `${editCount} payout-detail changes in 24 hours.`, severity: 'high',
      });
    }
    const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
    res.json({ bill: publicBill(updated, req.user), payoutHints: await getPayoutHints(bill.id), backToReview, reviewPacketId: packet ? packet.id : null });
  } catch (err) {
    next(err);
  }
});

// POST /api/uploads — multipart file upload. Field `file`, `kind` =
// public_bill|private_proof|support|avatar|id_doc|qr.
// GET /api/uploads/private/:file — private files, authenticated only
// (owner of the bill/verification referencing the file, or admin).
const uploadsRouter = express.Router();

uploadsRouter.post('/', requireActive, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large — the limit is 5 MB.'
        : err.message;
      return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message } });
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const kind = req.body?.kind || 'public_bill';
    if (!isKnownKind(kind)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Unknown upload kind: ${kind}.` } });
    }
    if (!req.file) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No file was uploaded.' } });
    }
    // Magic-byte check (item 135): the declared MIME type is client-claimed
    // and trivially faked — verify the file's real signature matches it,
    // and delete the file when it doesn't.
    if (!fileMatchesMime(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'That file is not a real image or PDF — please upload a genuine jpg, png, webp or PDF file.' },
      });
    }
    // Multer chooses the destination from req.body.kind, but multipart
    // fields arriving AFTER the file part aren't parsed yet when the file
    // stream starts — so a client sending `file` before `kind` (including
    // our own frontend's uploadFile) landed a PRIVATE file in the public
    // dir, publicly reachable and 404 on its private ref. Move the file
    // to the directory its kind requires.
    const expectedDir = isPrivateKind(kind) ? PRIVATE_DIR : PUBLIC_DIR;
    if (req.file.destination !== expectedDir) {
      const target = path.join(expectedDir, req.file.filename);
      fs.renameSync(req.file.path, target);
      req.file.path = target;
      req.file.destination = expectedDir;
    }
    // Item 856: photo-origin heuristic (web-download suspicion) — read
    // BEFORE stripping, since stripping removes the metadata it reads.
    const origin = inspectPhotoOrigin(req.file.path, req.file.mimetype);
    // Item 864: strip EXIF location/device metadata from photos on upload.
    const stripped = stripImageMetadata(req.file.path, req.file.mimetype);
    // Item 870: per-account storage quota (50 MB) — checked before the
    // upload is recorded; the file is deleted when the quota is exceeded.
    const used = await db.get(
      'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM uploads WHERE user_id = $1',
      [req.user.id]
    );
    const finalSize = fs.statSync(req.file.path).size;
    if (Number(used?.total || 0) + finalSize > UPLOAD_QUOTA_BYTES) {
      fs.unlink(req.file.path, () => {});
      return res.status(413).json({
        error: { code: 'QUOTA_EXCEEDED', message: 'Your upload storage is full (50 MB per account). Please delete an old bill photo first.' },
      });
    }
    await db.run(
      `INSERT INTO uploads (id, user_id, filename, size_bytes, kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), req.user.id, req.file.filename, finalSize, kind, nowIso()]
    );
    const url = isPrivateKind(kind) ? privateRefFor(req.file.filename) : publicUrlFor(req.file.filename);
    // Hash the stored file (items 324/338): SHA-256 for exact duplicates,
    // aHash (PNG only) for near-duplicates. Returned so the client can
    // show a duplicate warning early; the server re-hashes on submit.
    let sha256 = null;
    let ahash = null;
    try { sha256 = sha256File(req.file.path); } catch { /* absent */ }
    try { ahash = averageHash(req.file.path); } catch { /* PNG-only */ }
    res.status(201).json({
      ok: true,
      kind,
      url,
      filename: req.file.filename,
      size: finalSize,
      mimeType: req.file.mimetype,
      private: isPrivateKind(kind),
      metadataStripped: stripped.stripped,
      photoFlags: {
        webDownloadSuspected: origin.webDownloadSuspected,
        software: origin.software,
        hasExif: origin.hasExif,
      },
      sha256,
      ahash,
    });
  } catch (err) {
    next(err);
  }
});

// Serve a private file only to its owner or an admin. The file must be
// referenced by a bill's private_proof_url or a verification's doc_url.
uploadsRouter.get('/private/:file', async (req, res, next) => {
  try {
    const file = req.params.file;
    if (!/^[a-z0-9\-]+\.(jpg|jpeg|png|webp|pdf)$/i.test(file)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found.' } });
    }
    const ref = `/api/uploads/private/${file}`;
    let allowed = false;
    if (req.cookies?.sp_admin && (await lookupAdminSession(req.cookies.sp_admin))) {
      allowed = true;
    } else if (req.user) {
      const bill = await db.get(
        'SELECT id FROM bills WHERE private_proof_url = $1 AND user_id = $2', [ref, req.user.id]
      );
      const verif = bill ? null : await db.get(
        'SELECT id FROM verifications WHERE doc_url = $1 AND user_id = $2', [ref, req.user.id]
      );
      allowed = Boolean(bill || verif);
    }
    if (!allowed) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found.' } });
    }
    const fullPath = path.join(PRIVATE_DIR, file);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found.' } });
    }
    res.sendFile(fullPath);
  } catch (err) {
    next(err);
  }
});

// GET /api/bills/:id — public detail. 404 unless approved, or the requester
// is the owner or an admin. Pending bills must 404 for everyone else.
router.get('/:id', async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    const isOwner = req.user && req.user.id === bill.user_id;
    let isAdmin = false;
    if (req.cookies?.sp_admin) {
      isAdmin = Boolean(await lookupAdminSession(req.cookies.sp_admin));
    }
    if (effectiveStatus(bill) !== 'approved' && !isOwner && !isAdmin) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    const poster = await db.get('SELECT * FROM users WHERE id = $1', [bill.user_id]);
    // Expired badges don't count as verified (item 306).
    const liveBadges = await db.query(
      `SELECT type FROM verifications
       WHERE user_id = $1 AND status = 'approved' AND (expires_at IS NULL OR expires_at > $2)`,
      [bill.user_id, nowIso()]
    );
    const liveBillBadges = await db.query(
      `SELECT type FROM verifications
       WHERE bill_id = $1 AND status = 'approved' AND (expires_at IS NULL OR expires_at > $2)`,
      [bill.id, nowIso()]
    );
    const supporters = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url, g.amount_minor, g.confirmed_at, g.message, g.anonymous,
              (SELECT COUNT(*) FROM gifts g2 WHERE g2.supporter_id = u.id AND g2.status = 'confirmed') AS gift_count
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.bill_id = $1 AND g.status = 'confirmed' ORDER BY g.confirmed_at DESC LIMIT 50`,
      [bill.id]
    );
    // Pledge supporters (item 270): count only, never amounts.
    const pledgeRow = await db.get(
      `SELECT COUNT(*) AS c FROM pledges WHERE bill_id = $1 AND status = 'active'`,
      [bill.id]
    );
    // Count a view for non-owner public views.
    if (!isOwner && bill.status === 'approved') {
      db.run('UPDATE bills SET views = views + 1 WHERE id = $1', [bill.id]).catch(() => {});
    }
    const out = publicBill(bill, poster, !isOwner && !isAdmin);
    out.badges = [...new Set([...liveBillBadges.rows.map((r) => r.type), ...liveBadges.rows.map((r) => r.type)])];
    // Pay-direct verified (item 304): an approved biller badge for this
    // bill or its poster.
    out.payDirectVerified = out.badges.includes('biller');
    out.shareCount = Number(bill.share_count) || 0;
    // Supporters tab data (items 472/473): tier per supporter, anonymous
    // masking, top-supporter highlight (largest confirmed gift).
    let topAmount = 0;
    const supporterList = supporters.rows.map((r) => {
      const tier = tierForCount(Number(r.gift_count || 0)).tier;
      if (r.amount_minor > topAmount) topAmount = r.amount_minor;
      const anonymous = r.anonymous === 1;
      return {
        id: anonymous ? null : r.id,
        displayName: anonymous ? 'Anonymous' : r.display_name,
        username: anonymous ? null : r.username,
        photoUrl: anonymous ? null : r.photo_url,
        amountMinor: r.amount_minor,
        confirmedAt: r.confirmed_at,
        // Gift message (item 260): first name only; re-screened here
        // as defence in depth (items 257).
        message: r.message && !containsBlockedTerm(r.message) ? r.message : '',
        anonymous,
        tier: tier ? { key: tier.key, name: tier.name, icon: tier.icon } : null,
      };
    });
    out.supporters = supporterList.map((s) => ({ ...s, topSupporter: s.amountMinor === topAmount && topAmount > 0 }));
    out.pledgeCount = Number(pledgeRow?.c || 0);
    out.payoutHints = await getPayoutHints(bill.id);
    out.payoutHint = out.payoutHints.length ? out.payoutHints[0].hint : null;
    // Trust summary (item 309) + response time (item 397): badges, account
    // age, confirmed-gift count, first-bill label, median confirm latency.
    const posterStats = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM bills b2 WHERE b2.user_id = $1 AND b2.status = 'approved') AS approved_bills,
         (SELECT COUNT(*) FROM gifts g JOIN bills b3 ON b3.id = g.bill_id WHERE b3.user_id = $1 AND g.status = 'confirmed') AS confirmed_received`,
      [bill.user_id]
    );
    const latencies = await db.query(
      `SELECT g.created_at, g.confirmed_at FROM gifts g JOIN bills b3 ON b3.id = g.bill_id
       WHERE b3.user_id = $1 AND g.status = 'confirmed' AND g.confirmed_at IS NOT NULL
       ORDER BY g.confirmed_at DESC LIMIT 50`,
      [bill.user_id]
    );
    const hours = latencies.rows
      .map((r) => (new Date(r.confirmed_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);
    const medianHours = hours.length ? hours[Math.floor(hours.length / 2)] : null;
    out.trustSummary = {
      badges: out.badges,
      accountAgeDays: poster ? Math.max(0, Math.floor((Date.now() - new Date(poster.created_at).getTime()) / 86400000)) : 0,
      confirmedGiftsReceived: Number(posterStats?.confirmed_received || 0),
      approvedBills: Number(posterStats?.approved_bills || 0),
      firstBill: Number(posterStats?.approved_bills || 0) <= 1,
      responseTimeHours: medianHours === null ? null : Math.round(medianHours * 10) / 10,
    };
    if (isOwner) {
      out.rejectionReason = bill.rejection_reason;
      out.changesNote = bill.changes_note;
    }
    res.json({ bill: out });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/share — increment the share counter (item 442).
// Public (no auth): sharing is a public act; rate-limited by IP.
router.post('/:id/share', rateLimit('bill-share', 30, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const bill = await db.get('SELECT id, share_count FROM bills WHERE id = $1', [req.params.id]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    await db.run('UPDATE bills SET share_count = share_count + 1 WHERE id = $1', [bill.id]);
    res.json({ ok: true, shareCount: (Number(bill.share_count) || 0) + 1 });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/appeal — poster appeals a paused/removed/rejected
// bill (item 351). One open appeal per bill.
router.post('/:id/appeal', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (!['removed', 'under_investigation', 'rejected'].includes(bill.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill does not need an appeal.` } });
    }
    const body = cleanStr(req.body?.body || '', 2000);
    if (body.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please explain your appeal (10+ characters).' } });
    }
    const existing = await db.get(
      `SELECT id FROM appeals WHERE target_type = 'bill' AND target_id = $1 AND status = 'open'`,
      [bill.id]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'ALREADY_SUBMITTED', message: 'You already have an open appeal for this bill.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO appeals (id, user_id, target_type, target_id, body, status, reviewer_note, created_at, decided_at)
       VALUES ($1, $2, 'bill', $3, $4, 'open', '', $5, NULL)`,
      [id, req.user.id, bill.id, body, nowIso()]
    );
    await logAudit('user', req.user.id, 'appeal_filed', 'bill', bill.id, { appealId: id });
    res.status(201).json({ ok: true, appealId: id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.uploadsRouter = uploadsRouter;
module.exports.publicBill = publicBill;
module.exports.getPayoutHints = getPayoutHints;
module.exports.askTypeOf = askTypeOf;
module.exports.expiryOf = expiryOf;
module.exports.isExpired = isExpired;
module.exports.effectiveStatus = effectiveStatus;
module.exports.parsePhotos = parsePhotos;
module.exports.MAX_AMOUNT_MINOR = MAX_AMOUNT_MINOR;
