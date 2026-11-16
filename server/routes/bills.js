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
const { upload, isPrivateKind, isKnownKind, publicUrlFor, privateRefFor, encryptAccount, PUBLIC_DIR, PRIVATE_DIR, fileMatchesMime } = require('../lib/storage');
const { createReviewPacket, billPacketPayload } = require('../lib/notify');

const router = express.Router();

const MATERIAL_FIELDS = ['title', 'category', 'amountMinor', 'story', 'details', 'photoUrl', 'supportPhotoUrl', 'company', 'charity', 'payDirect'];

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
    anonymous,
    status: row.status,
    city: row.city,
    country: row.country,
    photoUrl: row.photo_url,
    supportPhotoUrl: row.support_photo_url,
    payDirect: row.pay_direct === 1,
    billerName: row.biller_name,
    billerRef: row.biller_ref,
    billerDestination: row.biller_destination,
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
      [crypto.randomUUID(), billId, method, cleanStr(m.holderName, 120), encryptAccount(v.account), v.hint, JSON.stringify(v.meta || {}), nowIso()]
    );
    hints.push(v.hint);
  }
  return { ok: true, hints };
}

async function getPayoutHints(billId) {
  const { rows } = await db.query('SELECT method, account_hint FROM payout_methods WHERE bill_id = $1', [billId]);
  return rows.map((r) => ({ method: r.method, hint: r.account_hint }));
}

function validateBillFields(body, categories) {
  const title = cleanStr(body.title, 80);
  if (title.length < 3) return { error: 'Please give your request a title (3–80 characters).' };
  if (!categories.includes(body.category)) return { error: 'Please choose a valid category.' };
  const story = cleanStr(body.story, 280);
  if (story.length < 10) return { error: 'Please tell your story (at least 10 characters, max 280).' };
  const amountMinor = typeof body.amountMinor === 'number'
    ? body.amountMinor
    : parseMajorToMinor(body.amount);
  if (!isMinorAmount(amountMinor)) return { error: 'Please enter a valid amount greater than zero.' };
  const details = cleanStr(body.details || '', 1500);
  const company = cleanStr(body.company || '', 120);
  return { ok: true, title, story, details, company, amountMinor };
}

// POST /api/bills — create a draft, or create + submit when submit=true.
router.post('/', requireActive, rateLimit('post-bill', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const categories = await db.getSettingJson('categories', []);
    const v = validateBillFields(body, categories);
    if (v.error) return res.status(400).json({ error: { code: 'VALIDATION', message: v.error } });

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
    if (submit && payDirect && (!cleanStr(body.billerName, 120) || !cleanStr(body.billerDestination, 500))) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'Pay-direct bills need the biller name and the official payment destination from the bill.' },
      });
    }

    const id = crypto.randomUUID();
    const now = nowIso();
    const status = submit ? 'pending_review' : 'draft';
    await db.run(
      `INSERT INTO bills (id, user_id, request_code, title, category, company, amount_minor, currency,
        covered_minor, due_date, story, details, charity, anonymous, status, city, country, photo_url,
        support_photo_url, private_proof_url, pay_direct, biller_name, biller_ref, biller_destination,
        views, report_count, rejection_reason, changes_note, approved_at, approved_by, completed_at,
        created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 0, 0, '', '', NULL, NULL, NULL, $24, $25)`,
      [
        id, req.user.id, await uniqueRequestCode(), v.title, body.category, v.company,
        v.amountMinor, currency, body.dueDate ? cleanStr(body.dueDate, 10) : null,
        v.story, v.details, body.charity === true ? 1 : 0, body.anonymous === true ? 1 : 0, status,
        cleanStr(body.city || req.user.city, 120), req.user.country,
        body.photoUrl ? cleanStr(body.photoUrl, 500) : null,
        body.supportPhotoUrl ? cleanStr(body.supportPhotoUrl, 500) : null,
        body.privateProofUrl ? cleanStr(body.privateProofUrl, 500) : null,
        payDirect ? 1 : 0,
        cleanStr(body.billerName || '', 120),
        cleanStr(body.billerRef || '', 120),
        cleanStr(body.billerDestination || '', 500),
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
    if (submit) {
      packet = await createReviewPacket('bill', id, await billPacketPayload(bill, await getPayoutHints(id)));
      await logAudit('user', req.user.id, 'bill_submitted', 'bill', id, { requestCode: bill.request_code });
    }
    res.status(201).json({
      bill: publicBill(bill, req.user),
      payoutHints: stored.hints,
      reviewPacketId: packet ? packet.id : null,
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
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT b.*,
              (SELECT COUNT(*) FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed') AS supporter_count
       FROM bills b WHERE ${where} ORDER BY b.created_at DESC LIMIT 100`,
      params
    );
    const bills = [];
    for (const r of rows) {
      const b = publicBill(r, req.user);
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
    const fieldMap = {
      title: (v) => cleanStr(v, 80),
      category: (v) => v,
      amountMinor: (v) => v,
      story: (v) => cleanStr(v, 280),
      details: (v) => cleanStr(v, 1500),
      photoUrl: (v) => cleanStr(v, 500),
      supportPhotoUrl: (v) => cleanStr(v, 500),
      privateProofUrl: (v) => cleanStr(v, 500),
      company: (v) => cleanStr(v, 120),
      dueDate: (v) => cleanStr(v, 10),
      charity: (v) => (v === true ? 1 : 0),
      anonymous: (v) => (v === true ? 1 : 0),
      payDirect: (v) => (v === true ? 1 : 0),
    };
    const colMap = {
      title: 'title', category: 'category', amountMinor: 'amount_minor', story: 'story',
      details: 'details', photoUrl: 'photo_url', supportPhotoUrl: 'support_photo_url',
      privateProofUrl: 'private_proof_url',
      company: 'company', dueDate: 'due_date', charity: 'charity', anonymous: 'anonymous', payDirect: 'pay_direct',
    };
    const updates = [];
    const params = [];
    let material = false;
    for (const [key, fn] of Object.entries(fieldMap)) {
      if (body[key] === undefined) continue;
      const value = fn(body[key]);
      if (key === 'category' && !categories.includes(value)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose a valid category.' } });
      }
      if (key === 'amountMinor' && !isMinorAmount(value)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
      }
      if (key === 'title' && value.length < 3) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title must be 3–80 characters.' } });
      }
      if (key === 'story' && value.length < 10) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Story must be at least 10 characters.' } });
      }
      params.push(value);
      updates.push(`${colMap[key]} = $${params.length}`);
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
    await logAudit('user', req.user.id, 'bill_removed', 'bill', bill.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/bills/:id/payout — replace payout methods. Changing the payout
// account on a LIVE bill pauses it (back to pending_review) until re-approved.
router.post('/:id/payout', requireActive, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill || bill.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    if (['completed', 'removed', 'expired'].includes(bill.status)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${bill.status} bill cannot change payout details.` } });
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
        [crypto.randomUUID(), bill.id, v.method, v.holderName, encryptAccount(v.account), v.hint, JSON.stringify(v.meta), nowIso()]
      );
    }
    let packet = null;
    let backToReview = false;
    if (bill.status === 'approved') {
      await db.run(`UPDATE bills SET status = 'pending_review', approved_at = NULL, updated_at = $1 WHERE id = $2`, [nowIso(), bill.id]);
      const updated = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
      packet = await createReviewPacket('bill', bill.id, await billPacketPayload(updated, await getPayoutHints(bill.id)));
      backToReview = true;
    }
    await logAudit('user', req.user.id, 'bill_payout_changed', 'bill', bill.id, { backToReview });
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
    const url = isPrivateKind(kind) ? privateRefFor(req.file.filename) : publicUrlFor(req.file.filename);
    res.status(201).json({
      ok: true,
      kind,
      url,
      filename: req.file.filename,
      size: req.file.size,
      mimeType: req.file.mimetype,
      private: isPrivateKind(kind),
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
    if (bill.status !== 'approved' && !isOwner && !isAdmin) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    }
    const poster = await db.get('SELECT * FROM users WHERE id = $1', [bill.user_id]);
    const badges = await db.query(
      `SELECT type FROM verifications WHERE bill_id = $1 AND status = 'approved'`,
      [bill.id]
    );
    const userBadges = await db.query(
      `SELECT type FROM verifications WHERE user_id = $1 AND bill_id IS NULL AND status = 'approved'`,
      [bill.user_id]
    );
    const supporters = await db.query(
      `SELECT u.display_name, u.username, g.amount_minor, g.confirmed_at
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.bill_id = $1 AND g.status = 'confirmed' ORDER BY g.confirmed_at DESC LIMIT 50`,
      [bill.id]
    );
    // Count a view for non-owner public views.
    if (!isOwner && bill.status === 'approved') {
      db.run('UPDATE bills SET views = views + 1 WHERE id = $1', [bill.id]).catch(() => {});
    }
    const out = publicBill(bill, poster, !isOwner && !isAdmin);
    out.badges = [...new Set([...badges.rows.map((r) => r.type), ...userBadges.rows.map((r) => r.type)])];
    out.supporters = supporters.rows.map((r) => ({
      displayName: r.display_name, username: r.username, amountMinor: r.amount_minor, confirmedAt: r.confirmed_at,
    }));
    out.payoutHints = await getPayoutHints(bill.id);
    out.payoutHint = out.payoutHints.length ? out.payoutHints[0].hint : null;
    if (isOwner) {
      out.rejectionReason = bill.rejection_reason;
      out.changesNote = bill.changes_note;
    }
    res.json({ bill: out });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.uploadsRouter = uploadsRouter;
module.exports.publicBill = publicBill;
module.exports.getPayoutHints = getPayoutHints;
