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
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    story: row.story,
    country: row.country,
    city: row.city,
    contentNoFee: row.content_no_fee === 1,
    status: row.status,
    createdAt: row.created_at,
    poster: poster ? {
      displayName: poster.display_name,
      username: poster.username,
      photoUrl: poster.photo_url,
    } : undefined,
  };
}

// GET /api/brands — approved asks only. Filters: brand, country, contentNoFee.
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = `status = 'approved'`;
    const brandQuery = req.query.brand || req.query.q;
    if (brandQuery) { params.push(`%${cleanStr(brandQuery, 120)}%`); where += ` AND name LIKE $${params.length}`; }
    if (['NP', 'IN'].includes(req.query.country)) { params.push(req.query.country); where += ` AND country = $${params.length}`; }
    if (req.query.contentNoFee === '1' || req.query.contentNoFee === 'true') where += ' AND content_no_fee = 1';
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
    const { rows } = await db.query(
      'SELECT * FROM brands WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    res.json({ brands: rows.map((r) => publicBrand(r, req.user)) });
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
    await db.run(
      `INSERT INTO brands (id, user_id, name, display_name, story, country, city, contact_phone, content_no_fee, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_review', $10)`,
      [
        id, req.user.id, name, cleanStr(body.displayName || '', 120), story, body.country,
        cleanStr(body.city || '', 120), cleanStr(body.contactPhone || '', 32),
        body.contentNoFee === true ? 1 : 0, now,
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
    await db.run(
      `INSERT INTO brand_connects (id, brand_id, brand_name, contact_name, phone, note, plan, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [id, brand.id, brandName, contactName, phone, cleanStr(body.note || '', 500), plan || 'pay', nowIso()]
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
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    const isOwner = req.user && req.user.id === brand.user_id;
    if (brand.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Brand ask not found.' } });
    }
    const poster = await db.get('SELECT * FROM users WHERE id = $1', [brand.user_id]);
    res.json({ brand: publicBrand(brand, poster) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
