// Sahay Pay — registered-brand directory, messaging, drops, CSR,
// partnerships (Phase 2 §6, items 501–512, 523–528, 539–554, 590–591, 597).
// The directory lists REGISTERED brands (brand_profiles), distinct from
// the brand ASKS board (routes/brands.js). All monetisation stays
// DEMO-ONLY: no payment credentials, no real money moves anywhere.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit, lookupAdminSession } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createReviewPacket, createNotification } = require('../lib/notify');

const router = express.Router();

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'yahoo.com',
  'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'aol.com', 'zoho.com',
]);

const INDUSTRIES = [
  'Food & Drink', 'Retail', 'Fashion', 'Technology', 'Health', 'Education',
  'Travel', 'Finance', 'Entertainment', 'Home & Living', 'Sports', 'Other',
];

function publicProfile(bp) {
  return {
    id: bp.id,
    ownerId: bp.owner_id,
    name: bp.name,
    industry: bp.industry,
    country: bp.country,
    city: bp.city,
    website: bp.website,
    description: bp.description,
    logoUrl: bp.logo_url,
    status: bp.status,
    verified: bp.verified === 1,
    rejectionReason: bp.rejection_reason || '',
    createdAt: bp.created_at,
    updatedAt: bp.updated_at,
  };
}

// --- Sponsored drops (items 539–543) ---
// Design + listing + register-interest + winner display. Demo Mode: no
// payment, no purchase — registration is one tap for signed-in users.
// (Defined before /:id so "drops" is not matched as a profile id.)

// GET /api/brand-directory/drops — open/upcoming drops + archive.
router.get('/drops', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*, u.display_name AS winner_name, u.username AS winner_username,
              (SELECT COUNT(*) FROM drop_entries e WHERE e.drop_id = d.id) AS entries
       FROM drops d LEFT JOIN users u ON u.id = d.winner_user_id
       ORDER BY d.created_at DESC LIMIT 50`
    );
    res.json({
      drops: rows.map((r) => ({
        id: r.id, brandProfileId: r.brand_profile_id, brandName: r.brand_name,
        title: r.title, product: r.product, quantity: r.quantity,
        eligibility: r.eligibility, status: r.status,
        winnerName: r.winner_name, winnerUsername: r.winner_username,
        entries: Number(r.entries || 0), createdAt: r.created_at, drawnAt: r.drawn_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/brand-directory/drops/:id/enter — one-tap register-interest (541).
router.post('/drops/:id/enter', requireActive, async (req, res, next) => {
  try {
    const drop = await db.get('SELECT * FROM drops WHERE id = $1', [req.params.id]);
    if (!drop) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Drop not found.' } });
    if (drop.status !== 'open') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `This drop is ${drop.status}, not open for entries.` } });
    }
    const existing = await db.get(
      'SELECT id FROM drop_entries WHERE drop_id = $1 AND user_id = $2', [drop.id, req.user.id]
    );
    if (existing) return res.json({ ok: true, entered: true });
    await db.run(
      `INSERT INTO drop_entries (id, drop_id, user_id, created_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), drop.id, req.user.id, nowIso()]
    );
    res.status(201).json({ ok: true, entered: true });
  } catch (err) {
    next(err);
  }
});

// --- Brand directory (items 501–503) ---

router.get('/directory', async (req, res, next) => {
  try {
    const params = [];
    let where = `status = 'approved'`;
    if (['NP', 'IN'].includes(req.query.country)) { params.push(req.query.country); where += ` AND country = $${params.length}`; }
    if (req.query.industry) {
      params.push(cleanStr(req.query.industry, 60));
      where += ` AND industry = $${params.length}`;
    }
    if (req.query.q) {
      const q = `%${cleanStr(req.query.q, 120)}%`;
      params.push(q); params.push(q); params.push(q);
      where += ` AND (name LIKE $${params.length - 2} OR description LIKE $${params.length - 1} OR city LIKE $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT * FROM brand_profiles WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    // New-this-week strip (item 596): approved in the last 7 days.
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    res.json({
      brands: rows.map(publicProfile),
      industries: INDUSTRIES,
      newThisWeek: rows.filter((r) => r.created_at >= weekAgo).map((r) => r.id),
      emptyMessage: rows.length === 0 ? 'No registered brands yet.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/mine — own applications + status tracking (509).
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM brand_profiles WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ brands: rows.map(publicProfile) });
  } catch (err) {
    next(err);
  }
});

// POST /api/brand-directory/apply — brand application form (511/512).
router.post('/apply', requireActive, rateLimit('brand-apply', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = cleanStr(body.name, 120);
    if (name.length < 2) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please name the brand.' } });
    if (!['NP', 'IN'].includes(body.country)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose Nepal or India.' } });
    }
    const industry = cleanStr(body.industry || '', 60);
    if (!INDUSTRIES.includes(industry)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose an industry.' } });
    }
    const description = cleanStr(body.description || '', 1500);
    if (description.length < 20) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please describe the brand (20–1500 characters).' } });
    }
    // Company-domain email required (item 512).
    const email = cleanStr(body.email || '', 200).toLowerCase();
    const domain = email.split('@')[1] || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A company email is required.' } });
    }
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: 'A company-domain email is required — personal Gmail, Hotmail, Outlook, iCloud and Yahoo addresses can\'t be used.' },
      });
    }
    const website = cleanStr(body.website || '', 300);
    if (website && !/^https?:\/\//i.test(website)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Website must start with http:// or https://.' } });
    }
    const logoUrl = body.logoUrl && String(body.logoUrl).startsWith('/uploads/public/')
      ? cleanStr(body.logoUrl, 500)
      : null;
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO brand_profiles (id, owner_id, name, industry, country, city, website, description, logo_url, email, status, verified, rejection_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_review', 0, '', $11, $11)`,
      [id, req.user.id, name, industry, body.country, cleanStr(body.city || '', 120), website, description, logoUrl, email, now]
    );
    const packet = await createReviewPacket('brand_profile', id, {
      kind: 'brand_profile',
      brandProfileId: id,
      name, industry, country: body.country, city: cleanStr(body.city || '', 120),
      website, description, email,
      owner: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'brand_applied', 'brand_profile', id, {});
    res.status(201).json({ ok: true, brandProfileId: id, reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/:id — brand profile page (504/523/597).
router.get('/:id', async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    const isOwner = req.user && req.user.id === bp.owner_id;
    if (bp.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    // Impact section (item 523): asks received/responded, collaborations.
    const impact = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM brands WHERE name = $1 AND status IN ('approved','closed','expired')) AS asks_received,
         (SELECT COUNT(*) FROM brand_responses WHERE brand_profile_id = $2) AS asks_responded,
         (SELECT COUNT(*) FROM brand_connects bc JOIN brands br ON br.id = bc.brand_id
          WHERE bc.status = 'connected' AND br.name = $3) AS collaborations`,
      [bp.name, bp.id, bp.name]
    );
    // Response-time display (item 597): median hours from ask approval to
    // first response by this brand.
    const responseTimes = await db.query(
      `SELECT br.created_at AS ask_created, MIN(r.created_at) AS first_response
       FROM brand_responses r JOIN brands br ON br.id = r.brand_id
       WHERE r.brand_profile_id = $1 GROUP BY br.id, br.created_at LIMIT 50`,
      [bp.id]
    );
    const hours = responseTimes.rows
      .map((r) => (new Date(r.first_response).getTime() - new Date(r.ask_created).getTime()) / 3600000)
      .filter((h) => Number.isFinite(h) && h >= 0)
      .sort((a, b) => a - b);
    const medianResponseHours = hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null;
    // Public responses by this brand.
    const responses = await db.query(
      `SELECT r.id, r.body, r.created_at, br.id AS ask_id, br.name AS ask_name
       FROM brand_responses r JOIN brands br ON br.id = r.brand_id
       WHERE r.brand_profile_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
      [bp.id]
    );
    // CSR updates.
    const csr = await db.query(
      `SELECT id, title, body, image_url, status, created_at FROM csr_updates
       WHERE brand_profile_id = $1 AND (status = 'approved' OR $2 = 1) ORDER BY created_at DESC LIMIT 20`,
      [bp.id, isOwner ? 1 : 0]
    );
    const out = publicProfile(bp);
    out.impact = {
      asksReceived: Number(impact?.asks_received || 0),
      asksResponded: Number(impact?.asks_responded || 0),
      collaborations: Number(impact?.collaborations || 0),
    };
    out.medianResponseHours = medianResponseHours;
    out.responses = responses.rows.map((r) => ({
      id: r.id, body: r.body, createdAt: r.created_at, askId: r.ask_id, askName: r.ask_name,
    }));
    out.csrUpdates = csr.rows.map((r) => ({
      id: r.id, title: r.title, body: r.body, imageUrl: r.image_url, status: r.status, createdAt: r.created_at,
    }));
    res.json({ brand: out });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/brand-directory/:id — brand-owner profile editing (505).
router.patch('/:id', requireActive, async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.owner_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    const body = req.body || {};
    const updates = [];
    const params = [];
    if (body.description !== undefined) {
      const d = cleanStr(body.description, 1500);
      if (d.length < 20) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Description must be 20–1500 characters.' } });
      params.push(d); updates.push(`description = $${params.length}`);
    }
    if (body.industry !== undefined) {
      if (!INDUSTRIES.includes(body.industry)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose an industry.' } });
      }
      params.push(body.industry); updates.push(`industry = $${params.length}`);
    }
    if (body.city !== undefined) { params.push(cleanStr(body.city, 120)); updates.push(`city = $${params.length}`); }
    if (body.website !== undefined) {
      const w = cleanStr(body.website, 300);
      if (w && !/^https?:\/\//i.test(w)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Website must start with http:// or https://.' } });
      }
      params.push(w); updates.push(`website = $${params.length}`);
    }
    if (body.logoUrl !== undefined) {
      if (body.logoUrl === '') {
        params.push(null); updates.push(`logo_url = $${params.length}`);
      } else if (String(body.logoUrl).startsWith('/uploads/public/')) {
        params.push(cleanStr(body.logoUrl, 500)); updates.push(`logo_url = $${params.length}`);
      } else {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Logo must be an uploaded image.' } });
      }
    }
    if (!updates.length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update.' } });
    }
    params.push(nowIso());
    updates.push(`updated_at = $${params.length}`);
    params.push(bp.id);
    await db.run(`UPDATE brand_profiles SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    await logAudit('user', req.user.id, 'brand_profile_updated', 'brand_profile', bp.id, {});
    const updated = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [bp.id]);
    res.json({ brand: publicProfile(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/brand-directory/:id/verify-request — ask the owner to check
// the brand's public registration details (item 506). The owner reviews
// public records manually; no licence or permission is involved.
router.post('/:id/verify-request', requireActive, async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.owner_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    if (bp.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only an approved brand can request verification.' } });
    }
    if (bp.verified === 1) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This brand is already verified.' } });
    }
    const note = cleanStr(req.body?.note || '', 1000);
    await logAudit('user', req.user.id, 'brand_verify_requested', 'brand_profile', bp.id, { note });
    // The owner sees this in the audit log + can verify from the admin
    // console (POST /api/admin/brand-profiles/:id/verify).
    res.json({ ok: true, message: 'Verification requested. The owner checks your public registration details manually.' });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/:id/report?month=YYYY-MM — monthly brand report (590).
router.get('/:id/report', requireAuth, async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.owner_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const end = new Date(Date.UTC(y, m, 1)).toISOString();
    const q = async (sql, params = []) => Number((await db.get(sql, params))?.c || 0);
    const asks = await q(
      `SELECT COUNT(*) AS c FROM brands WHERE name = $1 AND created_at >= $2 AND created_at < $3`,
      [bp.name, start, end]
    );
    const responses = await q(
      `SELECT COUNT(*) AS c FROM brand_responses WHERE brand_profile_id = $1 AND created_at >= $2 AND created_at < $3`,
      [bp.id, start, end]
    );
    const messages = await q(
      `SELECT COUNT(*) AS c FROM messages msg JOIN message_threads t ON t.id = msg.thread_id
       WHERE t.brand_profile_id = $1 AND msg.created_at >= $2 AND msg.created_at < $3`,
      [bp.id, start, end]
    );
    // Profile views are not tracked (no analytics by design) — report
    // asks/responses/messages only, honestly.
    res.json({ month, asks, responses, messages, profileViews: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/:id/checklist — onboarding checklist (591).
router.get('/:id/checklist', requireAuth, async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.owner_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    const firstResponse = await db.get(
      'SELECT id FROM brand_responses WHERE brand_profile_id = $1 LIMIT 1', [bp.id]
    );
    res.json({
      checklist: [
        { key: 'profile', label: 'Profile complete (description, industry, city)', done: Boolean(bp.description && bp.industry && bp.city) },
        { key: 'logo', label: 'Logo uploaded', done: Boolean(bp.logo_url) },
        { key: 'approved', label: 'Application approved', done: bp.status === 'approved' },
        { key: 'verified', label: 'Business verified', done: bp.verified === 1 },
        { key: 'first_response', label: 'First public response posted', done: Boolean(firstResponse) },
      ],
    });
  } catch (err) {
    next(err);
  }
});

// --- Messaging (items 524–528) ---

// POST /api/brand-directory/threads {brandProfileId, askId} — open a thread
// after the brand responds. Either side (brand owner or asker) can open it.
router.post('/threads', requireActive, async (req, res, next) => {
  try {
    const brandProfileId = cleanStr(req.body?.brandProfileId, 64);
    const askId = cleanStr(req.body?.askId, 64);
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
    const ask = await db.get('SELECT * FROM brands WHERE id = $1', [askId]);
    if (!bp || !ask) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand or ask not found.' } });
    const isBrandOwner = bp.owner_id === req.user.id;
    const isAsker = ask.user_id === req.user.id;
    if (!isBrandOwner && !isAsker) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the brand owner or the asker can open this thread.' } });
    }
    // A thread needs a public brand response first (item 524).
    const responded = await db.get(
      'SELECT id FROM brand_responses WHERE brand_id = $1 AND brand_profile_id = $2 LIMIT 1',
      [ask.id, bp.id]
    );
    if (!responded) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'The brand must respond publicly before messaging opens.' } });
    }
    const existing = await db.get(
      'SELECT * FROM message_threads WHERE brand_profile_id = $1 AND ask_id = $2',
      [bp.id, ask.id]
    );
    if (existing) return res.json({ thread: { id: existing.id, brandProfileId: bp.id, askId: ask.id } });
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO message_threads (id, brand_profile_id, ask_id, asker_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, bp.id, ask.id, ask.user_id, now]
    );
    res.status(201).json({ thread: { id, brandProfileId: bp.id, askId: ask.id } });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/threads — own threads (brand dashboard view, 525).
router.get('/threads', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, bp.name AS brand_name, br.name AS ask_name,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.is_read = 0 AND m.sender_id != $1) AS unread
       FROM message_threads t
       JOIN brand_profiles bp ON bp.id = t.brand_profile_id
       JOIN brands br ON br.id = t.ask_id
       WHERE t.asker_id = $1 OR bp.owner_id = $1
       ORDER BY t.updated_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({
      threads: rows.map((r) => ({
        id: r.id, brandProfileId: r.brand_profile_id, brandName: r.brand_name,
        askId: r.ask_id, askName: r.ask_name, unread: Number(r.unread || 0), updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/brand-directory/threads/:id — thread messages (525).
router.get('/threads/:id', requireAuth, async (req, res, next) => {
  try {
    const thread = await db.get('SELECT * FROM message_threads WHERE id = $1', [req.params.id]);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Thread not found.' } });
    const bp = await db.get('SELECT owner_id, name FROM brand_profiles WHERE id = $1', [thread.brand_profile_id]);
    const allowed = thread.asker_id === req.user.id || bp?.owner_id === req.user.id;
    if (!allowed) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This thread is not yours.' } });
    const { rows } = await db.query(
      `SELECT m.*, u.display_name AS sender_name, u.username AS sender_username
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
      [thread.id]
    );
    // Mark others' messages read.
    await db.run(
      'UPDATE messages SET is_read = 1 WHERE thread_id = $1 AND sender_id != $2',
      [thread.id, req.user.id]
    );
    res.json({
      thread: { id: thread.id, brandProfileId: thread.brand_profile_id, brandName: bp?.name, askId: thread.ask_id },
      messages: rows.map((r) => ({
        id: r.id, senderId: r.sender_id, senderName: r.sender_name,
        senderUsername: r.sender_username, body: r.body, isRead: r.is_read === 1, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/brand-directory/threads/:id/messages — send a message.
router.post('/threads/:id/messages', requireActive, rateLimit('message', 30, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const thread = await db.get('SELECT * FROM message_threads WHERE id = $1', [req.params.id]);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Thread not found.' } });
    const bp = await db.get('SELECT owner_id FROM brand_profiles WHERE id = $1', [thread.brand_profile_id]);
    const isBrandOwner = bp?.owner_id === req.user.id;
    const isAsker = thread.asker_id === req.user.id;
    if (!isBrandOwner && !isAsker) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This thread is not yours.' } });
    }
    // Brand block-asker (item 528): a server block stops messaging.
    const otherId = isBrandOwner ? thread.asker_id : bp.owner_id;
    const blocked = await db.get(
      `SELECT id FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [req.user.id, otherId]
    );
    if (blocked) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Messaging is blocked between these accounts.' } });
    }
    const body = cleanStr(req.body?.body || '', 2000);
    if (body.length < 1) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please write a message.' } });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO messages (id, thread_id, sender_id, body, is_read, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
      [id, thread.id, req.user.id, body, now]
    );
    await db.run('UPDATE message_threads SET updated_at = $1 WHERE id = $2', [now, thread.id]);
    // New-message notification (item 526).
    await createNotification(
      otherId, 'new_message', 'New message from a brand conversation',
      `${req.user.displayName}: ${body.slice(0, 120)}`,
      `#/brand-messages/${thread.id}`
    );
    res.status(201).json({ ok: true, messageId: id });
  } catch (err) {
    next(err);
  }
});

// --- CSR updates (items 548–551) ---

// POST /api/brand-directory/:id/csr — submission form for verified brands (550).
router.post('/:id/csr', requireActive, async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.owner_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand not found.' } });
    }
    if (bp.verified !== 1) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only verified brands can post CSR updates.' } });
    }
    const title = cleanStr(req.body?.title, 200);
    const body = cleanStr(req.body?.body || '', 5000);
    if (title.length < 3 || body.length < 20) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title (3+) and body (20+) are required.' } });
    }
    const imageUrl = req.body?.imageUrl && String(req.body.imageUrl).startsWith('/uploads/public/')
      ? cleanStr(req.body.imageUrl, 500)
      : null;
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO csr_updates (id, brand_profile_id, title, body, image_url, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending_review', $6)`,
      [id, bp.id, title, body, imageUrl, nowIso()]
    );
    const packet = await createReviewPacket('csr', id, {
      kind: 'csr',
      csrId: id,
      brandProfileId: bp.id,
      brandName: bp.name,
      title, body, imageUrl,
    });
    await logAudit('user', req.user.id, 'csr_submitted', 'csr', id, { brandProfileId: bp.id });
    res.status(201).json({ ok: true, csrId: id, reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// --- Partnerships (items 552–554) ---

// POST /api/brand-directory/partnerships — interest form (553). The
// contact email is collected for the owner to reply outside the platform
// (same precedent as brand-connect work email); the platform sends no email.
router.post('/partnerships', requireActive, rateLimit('partnership', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const orgName = cleanStr(body.orgName, 200);
    const email = cleanStr(body.contactEmail || '', 200).toLowerCase();
    const type = cleanStr(body.type || '', 60);
    const proposal = cleanStr(body.proposal || '', 2000);
    if (orgName.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please name your organisation.' } });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A contact email is required.' } });
    }
    if (proposal.length < 20) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please describe the partnership idea (20+ characters).' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO partnerships (id, user_id, org_name, contact_email, type, proposal, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
      [id, req.user.id, orgName, email, type, proposal, nowIso()]
    );
    await logAudit('user', req.user.id, 'partnership_submitted', 'partnership', id, {});
    res.status(201).json({ ok: true, partnershipId: id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
