// Sahay Pay — shareable OG pages (Phase 2 items 438–440, 587–589).
// Hash routes are invisible to crawlers, so these clean /share/... URLs
// serve full OG/Twitter meta and redirect humans to the hash route.
// Netlify serves them through the /.netlify/functions/api proxy — see the
// /share/* redirect in netlify.toml.

'use strict';

const express = require('express');
const db = require('../db');
const { sharePage } = require('../lib/og');

const router = express.Router();

function host(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// GET /share/bill/:id — item 438.
router.get('/bill/:id', async (req, res, next) => {
  try {
    const bill = await db.get(
      `SELECT b.*, u.display_name AS poster_name FROM bills b JOIN users u ON u.id = b.user_id WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bill || bill.status !== 'published') return res.status(404).send('Not found');
    const raised = Number(bill.raised_minor || 0);
    const target = Number(bill.amount_minor || 0);
    const pct = target > 0 ? Math.round((raised / target) * 100) : 0;
    res.type('html').send(sharePage({
      title: `Help ${bill.poster_name} with ${bill.title} — Sahay Pay`,
      description: `${bill.title}: ${Math.floor(raised / 100)} of ${Math.floor(target / 100)} ${bill.currency} raised (${pct}%). A little help from many people covers a bill that one person can't.`,
      url: `${host(req)}/share/bill/${bill.id}`,
      image: bill.image_url ? `${host(req)}${bill.image_url}` : undefined,
      redirectTo: `#/bill/${bill.id}`,
      type: 'article',
    }));
  } catch (err) {
    next(err);
  }
});

// GET /share/profile/:username — item 439.
router.get('/profile/:username', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE username = $1', [req.params.username]);
    if (!user) return res.status(404).send('Not found');
    const totals = await db.get(
      `SELECT COALESCE(SUM(g.amount_minor), 0) AS given
       FROM gifts g WHERE g.helper_id = $1 AND g.status = 'confirmed'`,
      [user.id]
    );
    res.type('html').send(sharePage({
      title: `${user.display_name} on Sahay Pay`,
      description: `${user.display_name} has helped cover ${Math.floor(Number(totals?.given || 0) / 100)} ${user.country === 'IN' ? '₹' : 'रू'} of bills on Sahay Pay. Join in — a little help from many people.`,
      url: `${host(req)}/share/profile/${user.username}`,
      image: user.photo_url ? `${host(req)}${user.photo_url}` : undefined,
      redirectTo: `#/profile/${user.username}`,
      type: 'profile',
    }));
  } catch (err) {
    next(err);
  }
});

// GET /share/hof — Hall of Fame (item 439).
router.get('/hof', (req, res) => {
  res.type('html').send(sharePage({
    title: 'Hall of Fame — Sahay Pay',
    description: 'The helpers who have covered the most bills on Sahay Pay. A little help from many people.',
    url: `${host(req)}/share/hof`,
    redirectTo: '#/hall-of-fame',
  }));
});

// GET /share/brands — brands board (items 587/588).
router.get('/brands', (req, res) => {
  res.type('html').send(sharePage({
    title: 'Brand asks — Sahay Pay',
    description: 'People asking brands for help on Sahay Pay: products, collaborations and sponsorships for good causes.',
    url: `${host(req)}/share/brands`,
    redirectTo: '#/brands',
  }));
});

// GET /share/brand-ask/:id — one ask (items 587/588).
router.get('/brand-ask/:id', async (req, res, next) => {
  try {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [req.params.id]);
    if (!brand || brand.status !== 'approved') return res.status(404).send('Not found');
    res.type('html').send(sharePage({
      title: `Ask ${brand.name} — Sahay Pay`,
      description: brand.story ? brand.story.slice(0, 180) : `A community ask for ${brand.name} on Sahay Pay.`,
      url: `${host(req)}/share/brand-ask/${brand.id}`,
      image: brand.visual_url ? `${host(req)}${brand.visual_url}` : undefined,
      redirectTo: `#/brand/${brand.id}`,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /share/brand/:id — directory brand profile (item 589).
router.get('/brand/:id', async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.status !== 'approved') return res.status(404).send('Not found');
    res.type('html').send(sharePage({
      title: `${bp.name} — Sahay Pay`,
      description: bp.description ? bp.description.slice(0, 180) : `${bp.name} on Sahay Pay's brand directory.`,
      url: `${host(req)}/share/brand/${bp.id}`,
      image: bp.logo_url ? `${host(req)}${bp.logo_url}` : undefined,
      redirectTo: `#/brand-directory/${bp.id}`,
      type: 'profile',
    }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
