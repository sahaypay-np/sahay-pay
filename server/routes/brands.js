// Sahay Pay — brands routes.
// GET /api/brands, GET /api/brands/:id (public, approved only),
// POST /api/brands (ask -> pending_review), GET /api/brands/mine,
// POST /api/brands/:id/connect (Demo Mode, no charge).
// Brand asks are for products/help/collabs — NOT cash. Contact details,
// @handles and links are stripped from ask text (anti-circumvention).

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createReviewPacket, createNotification } = require('../lib/notify');

const router = express.Router();

// Strip emails, @handles, URLs and phone-like numbers from brand-ask text.
function stripContactDetails(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[removed]')
    .replace(/https?:\/\/\S+/gi, '[removed]')
    .replace(/www\.\S+/gi, '[removed]')
    .replace(/@[\w.]{2,}/g, '[removed]')
    .replace(/\b\d{7,}\b/g, '[removed]');
}

function publicBrand(row, poster) {
  const tags = typeof row.tags === 'string' && row.tags
    ? row.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    story: row.story,
    country: row.country,
    city: row.city,
    contentNoFee: row.content_no_fee === 1,
    status: row.status,
    visualUrl: row.visual_url || null,
    tags,
    closedAt: row.closed_at || null,
    thankYouNote: row.thank_you_note || '',
    expiresAt: row.expires_at || null,
    expired: row.status === 'approved' && row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false,
    createdAt: row.created_at,
    poster: poster ? {
      displayName: poster.display_name,
      username: poster.username,
      photoUrl: poster.photo_url,
    } : undefined,
  };
}

// Lazy ask expiry (item 598): approved asks with no response close after
// 60 days. Evaluated on read — no scheduler on the free tier. The asker
// is notified once, when the expiry is first observed.
async function expireStaleAsks() {
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, name FROM brands
       WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= $1 LIMIT 50`,
      [nowIso()]
    );
    for (const r of rows) {
      await db.run(`UPDATE brands SET status = 'expired' WHERE id = $1 AND status = 'approved'`, [r.id]);
      await createNotification(
        r.user_id, 'brand_ask_expired', 'Your brand ask closed',
        `Your ask for ${r.name} closed after 60 days without a response. You can renew it with one tap.`,
        `#/brand/${r.id}`
      );
    }
  } catch { /* expiry is best-effort */ }
}

// GET /api/brands — approved asks only. Filters: brand, country, contentNoFee, tag.
router.get('/', async (req, res, next) => {
  try {
    await expireStaleAsks();
    const params = [];
    let where = `status = 'approved'`;
    const brandQuery = req.query.brand || req.query.q;
    // Search matches brand name AND story keywords (item 595).
    if (brandQuery) {
      const q = `%${cleanStr(brandQuery, 120)}%`;
      params.push(q); params.push(q);
      where += ` AND (name LIKE $${params.length - 1} OR story LIKE $${params.length})`;
    }
    if (['NP', 'IN'].includes(req.query.country)) { params.push(req.query.country); where += ` AND country = $${params.length}`; }
    if (req.query.contentNoFee === '1' || req.query.contentNoFee === 'true') where += ' AND content_no_fee = 1';
    // Tag filter (item 594): product | collaboration | sponsorship | help.
    if (['product', 'collaboration', 'sponsorship', 'help'].includes(req.query.tag)) {
      params.push(`%${req.query.tag}%`);
      where += ` AND tags LIKE $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT b.*, u.display_name AS poster_name, u.username AS poster_username, u.photo_url AS poster_photo
       FROM brands b JOIN users u ON u.id = b.user_id
       WHERE ${where} ORDER BY b.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      brands: rows.map((r) => publicBrand(r, {
        display_name: r.poster_name, username: r.poster_username, photo_url: r.poster_photo,
      })),
      emptyMessage: rows.length === 0 ? 'No brand asks yet.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    await expireStaleAsks();
    const { rows } = await db.query(
      'SELECT * FROM brands WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    res.json({ brands: rows.map((r) => publicBrand(r, req.user)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/brands/connects/mine — own connect requests + status (item 536).
router.get('/connects/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT bc.*, br.name AS ask_name FROM brand_connects bc JOIN brands br ON br.id = bc.brand_id
       WHERE bc.requester_id = $1 ORDER BY bc.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({
      connects: rows.map((r) => ({
        id: r.id, brandId: r.brand_id, askName: r.ask_name, brandName: r.brand_name,
        contactName: r.contact_name, plan: r.plan, status: r.status, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/brands — submit a brand ask (goes to owner approval).
router.post('/', requireActive, rateLimit('post-brand', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = cleanStr(body.name, 120);
    if (name.length < 2) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please name the brand.' } });
    const story = stripContactDetails(cleanStr(body.story, 1500));
    if (story.length < 20) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Tell the brand your story (20–1500 characters). Keep it real: products, help, collabs — not cash.' } });
    if (!['NP', 'IN'].includes(body.country)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please choose Nepal or India.' } });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    // Visual plan (item 514): the uploaded image URL is now stored + shown.
    const visualUrl = body.visualUrl && String(body.visualUrl).startsWith('/uploads/public/')
      ? cleanStr(body.visualUrl, 500)
      : null;
    // Ask category tags (item 594).
    const TAG_SET = new Set(['product', 'collaboration', 'sponsorship', 'help']);
    const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','))
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => TAG_SET.has(t));
    await db.run(
      `INSERT INTO brands (id, user_id, name, display_name, story, country, city, contact_phone, content_no_fee, status, visual_url, tags, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_review', $10, $11, $12)`,
      [
        id, req.user.id, name, cleanStr(body.displayName || '', 120), story, body.country,
        cleanStr(body.city || '', 120), cleanStr(body.contactPhone || '', 32),
        body.contentNoFee === true ? 1 : 0, visualUrl, tags.join(','), now,
      ]
    );
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [id]);
    const packet = await createReviewPacket('brand', id, {
      kind: 'brand',
      brandId: id,
      name,
      displayName: brand.display_name,
      story,
      country: body.country,
      city: brand.city,
      contentNoFee: brand.content_no_fee === 1,
      visualUrl,
      tags,
      requester: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'brand_submitted', 'brand', id, {});
    res.status(201).json({ brand: publicBrand(brand, req.user), reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/brands/:id/connect — brand wants to connect with the asker.
// DEMO MODE: no charge is taken. The plan route requires a company-domain
// email (personal Gmail/Hotmail/etc. rejected with a plain explanation).
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'yahoo.com',
  'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'aol.com', 'zoho.com',
]);

router.post('/:id/connect', requireActive, async (req, res, next) => {
  try {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand || brand.status !== 'approved') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    const body = req.body || {};
    const brandName = cleanStr(body.brandName, 120);
    const contactName = cleanStr(body.contactName, 120);
    const phone = cleanStr(body.phone, 32);
    if (brandName.length < 2 || contactName.length < 2 || phone.length < 7) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Brand name, contact name and phone are required.' } });
    }
    const plan = cleanStr(body.plan, 32); // '' | 'pay' | 'free' | package id (plus, campaign, plan)
    // Any paid package route requires a company-domain work email (personal
    // Gmail/Hotmail/etc. rejected with a plain explanation). Accepts the
    // workEmail field (or the legacy email field).
    const needsWorkEmail = plan && plan !== 'pay' && plan !== 'free';
    if (needsWorkEmail) {
      const email = cleanStr(body.workEmail || body.email, 200).toLowerCase();
      const domain = email.split('@')[1] || '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'A work email is required for the plan route.' } });
      }
      if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
        return res.status(400).json({
          error: { code: 'VALIDATION', message: 'A company-domain email is required — personal Gmail, Hotmail, Outlook, iCloud and Yahoo addresses can\'t be used as the connect email.' },
        });
      }
    }
    const id = crypto.randomUUID();
    // Industry + what the brand hopes to offer (item 535); the work email
    // is stored for paid plans (company-domain rule above).
    const workEmail = cleanStr(body.workEmail || body.email || '', 200).toLowerCase();
    await db.run(
      `INSERT INTO brand_connects (id, brand_id, brand_name, contact_name, phone, note, plan, industry, offer, work_email, requester_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)`,
      [id, brand.id, brandName, contactName, phone, cleanStr(body.note || '', 500), plan || 'pay',
       cleanStr(body.industry || '', 120), cleanStr(body.offer || '', 500), workEmail, req.user.id, nowIso()]
    );
    await createNotification(
      brand.user_id, 'brand_connect', 'A brand wants to connect',
      `${brandName} asked to connect about your ask for ${brand.name}.`,
      `#/brand/${brand.id}`
    );
    await logAudit('user', req.user.id, 'brand_connect_requested', 'brand', brand.id, { connectId: id, plan: plan || 'pay' });
    res.status(201).json({
      ok: true,
      connectId: id,
      demoMode: true,
      message: 'Connection request recorded. Demo Mode: no payment was taken. The asker is never obliged to work with the brand.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/brands/:id — approved only (owner sees their own pending ask too).
router.get('/:id', async (req, res, next) => {
  try {
    await expireStaleAsks();
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    const isOwner = req.user && req.user.id === brand.user_id;
    if (brand.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    const poster = await db.get('SELECT * FROM users WHERE id = $1', [brand.user_id]);
    // Public brand responses (item 520).
    const responses = await db.query(
      `SELECT r.id, r.body, r.created_at, bp.name AS brand_name, bp.id AS brand_profile_id, bp.verified
       FROM brand_responses r LEFT JOIN brand_profiles bp ON bp.id = r.brand_profile_id
       WHERE r.brand_id = $1 ORDER BY r.created_at ASC LIMIT 50`,
      [brand.id]
    );
    const out = publicBrand(brand, poster);
    out.responses = responses.rows.map((r) => ({
      id: r.id, body: r.body, createdAt: r.created_at,
      brandName: r.brand_name || 'Sahay Pay', brandProfileId: r.brand_profile_id,
      verified: r.verified === 1,
    }));
    res.json({ brand: out });
  } catch (err) {
    next(err);
  }
});

// POST /api/brands/:id/respond — public brand response (item 520).
// From a registered brand's dashboard (brandProfileId + user session) or,
// until brands register, posted by the owner via the admin session.
router.post('/:id/respond', async (req, res, next) => {
  try {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand || brand.status !== 'approved') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    const body = cleanStr(req.body?.body || '', 2000);
    if (body.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please write a response (10+ characters).' } });
    }
    let brandProfileId = null;
    let actorId = 'owner';
    let actorType = 'admin';
    if (req.body?.brandProfileId) {
      if (!req.user) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please create a profile to continue.' } });
      }
      const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [cleanStr(req.body.brandProfileId, 64)]);
      if (!bp || bp.owner_id !== req.user.id || bp.status !== 'approved') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the owner of an approved brand profile can respond as that brand.' } });
      }
      brandProfileId = bp.id;
      actorId = req.user.id;
      actorType = 'user';
    } else {
      // Owner-posted response: admin session + admin CSRF token required
      // (this route is not under /api/admin, so verifyCsrf does not check
      // the admin token — check it explicitly).
      const { lookupAdminSession } = require('../lib/auth');
      const adminRow = req.cookies?.sp_admin ? await lookupAdminSession(req.cookies.sp_admin) : null;
      if (!adminRow) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Responses come from a registered brand profile.' } });
      }
      const presented = req.headers['x-csrf-token'];
      if (!adminRow.csrf_token || presented !== adminRow.csrf_token) {
        return res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Security token missing or expired. Please reload and try again.' } });
      }
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO brand_responses (id, brand_id, brand_profile_id, body, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, brand.id, brandProfileId, body, nowIso()]
    );
    await createNotification(
      brand.user_id, 'brand_response', 'A brand responded to your ask',
      `Your ask for ${brand.name} has a public response.`, `#/brand/${brand.id}`
    );
    await logAudit(actorType, actorId, 'brand_response_posted', 'brand', brand.id, { responseId: id, brandProfileId });
    res.status(201).json({ ok: true, responseId: id });
  } catch (err) {
    next(err);
  }
});

// POST /api/brands/:id/close — close with a public thank-you note (item 530).
router.post('/:id/close', requireActive, async (req, res, next) => {
  try {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand || brand.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    if (brand.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `A ${brand.status} ask cannot be closed.` } });
    }
    const note = cleanStr(req.body?.thankYouNote || '', 1000);
    await db.run(
      `UPDATE brands SET status = 'closed', closed_at = $1, thank_you_note = $2 WHERE id = $3`,
      [nowIso(), note, brand.id]
    );
    await logAudit('user', req.user.id, 'brand_ask_closed', 'brand', brand.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/brands/:id/renew — one-tap renewal with edit (item 599).
router.post('/:id/renew', requireActive, async (req, res, next) => {
  try {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand || brand.user_id !== req.user.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    if (brand.status !== 'expired') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only an expired ask can be renewed.' } });
    }
    // Optional edit on renewal: story + tags.
    const updates = [];
    const params = [];
    if (req.body?.story !== undefined) {
      const story = stripContactDetails(cleanStr(req.body.story, 1500));
      if (story.length < 20) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Story must be 20–1500 characters.' } });
      }
      params.push(story); updates.push(`story = $${params.length}`);
    }
    if (req.body?.tags !== undefined) {
      const TAG_SET = new Set(['product', 'collaboration', 'sponsorship', 'help']);
      const tags = (Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(','))
        .map((t) => String(t).trim().toLowerCase()).filter((t) => TAG_SET.has(t));
      params.push(tags.join(',')); updates.push(`tags = $${params.length}`);
    }
    const expiresAt = new Date(Date.now() + 60 * 86400000).toISOString();
    params.push(expiresAt);
    updates.push(`expires_at = $${params.length}`);
    updates.push(`status = 'approved'`);
    updates.push(`closed_at = NULL`);
    params.push(brand.id);
    await db.run(`UPDATE brands SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    await logAudit('user', req.user.id, 'brand_ask_renewed', 'brand', brand.id, {});
    const updated = await db.get('SELECT * FROM brands WHERE id = $1', [brand.id]);
    res.json({ brand: publicBrand(updated, req.user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
