// Sahay Pay — basket, pledges, biller directory (Phase 2, section 3).
// GET|POST|PUT|DELETE /api/basket, POST /api/basket/merge,
// POST /api/pledges, GET /api/pledges/mine, POST /api/pledges/:id/pause|resume|cancel|mark-sent,
// GET /api/billers (public, active entries only).
// Demo Mode: the basket holds intended gifts only; pledges are reminder
// schedules with NO automatic payment — the helper always sends manually.

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { isMinorAmount } = require('../lib/money');
const { expiryOf, isExpired, effectiveStatus } = require('./bills');

const router = express.Router();

// --- Basket (items 246–255, 291) ---

function publicBasketItem(r) {
  const expired = isExpired(r);
  const effective = effectiveStatus(r);
  const flag =
    effective === 'completed' ? 'funded'
    : effective === 'expired' ? 'expired'
    : ['removed', 'under_investigation', 'paused'].includes(r.status) ? 'paused'
    : null;
  return {
    billId: r.item_bill_id || r.id,
    title: r.title,
    category: r.category,
    amountMinor: r.amount_minor,
    coveredMinor: r.covered_minor,
    remainingMinor: Math.max(0, r.amount_minor - r.covered_minor),
    currency: r.currency,
    country: r.country,
    city: r.city,
    photoUrl: r.photo_url,
    payDirect: r.pay_direct === 1,
    status: r.status,
    effectiveStatus: effective,
    expired,
    flag, // 'funded' | 'expired' | 'paused' | null — item 255
    amountMinor: r.item_amount_minor,
    savedForLater: r.saved_for_later === 1,
    addedAt: r.item_created_at,
  };
}

router.get('/basket', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, bi.bill_id AS item_bill_id, bi.amount_minor AS item_amount_minor,
              bi.saved_for_later AS saved_for_later, bi.created_at AS item_created_at
       FROM basket_items bi JOIN bills b ON b.id = bi.bill_id
       WHERE bi.user_id = $1 ORDER BY bi.created_at ASC`,
      [req.user.id]
    );
    res.json({ items: rows.map(publicBasketItem) });
  } catch (err) {
    next(err);
  }
});

router.post('/basket', requireActive, rateLimit('basket-add', 60, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const billId = cleanStr(req.body?.billId, 64);
    const amountMinor = req.body?.amountMinor;
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.status !== 'approved' || isExpired(bill)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only open bills can be added to the basket.' } });
    }
    if (amountMinor !== undefined && amountMinor !== null && !isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Basket amount must be a positive number of minor units.' } });
    }
    const remaining = bill.amount_minor - bill.covered_minor;
    if (amountMinor && amountMinor > remaining) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
    }
    const now = nowIso();
    await db.run(
      `INSERT INTO basket_items (user_id, bill_id, amount_minor, saved_for_later, created_at)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT(user_id, bill_id) DO UPDATE SET amount_minor = COALESCE(excluded.amount_minor, basket_items.amount_minor)`,
      [req.user.id, bill.id, amountMinor || null, now]
    );
    res.status(201).json({ ok: true, billId: bill.id });
  } catch (err) {
    next(err);
  }
});

// One-time merge of a device-local (localStorage) basket after login
// (item 250): the server basket is authoritative once signed in.
router.post('/basket/merge', requireActive, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.billIds) ? req.body.billIds.filter((x) => typeof x === 'string').slice(0, 100) : [];
    let added = 0;
    const now = nowIso();
    for (const billId of ids) {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
      if (!bill || bill.status !== 'approved' || isExpired(bill)) continue;
      await db.run(
        `INSERT INTO basket_items (user_id, bill_id, amount_minor, saved_for_later, created_at)
         VALUES ($1, $2, NULL, 0, $3) ON CONFLICT(user_id, bill_id) DO NOTHING`,
        [req.user.id, bill.id, now]
      );
      added++;
    }
    res.json({ ok: true, added });
  } catch (err) {
    next(err);
  }
});

router.put('/basket/:billId', requireActive, async (req, res, next) => {
  try {
    const item = await db.get(
      'SELECT * FROM basket_items WHERE user_id = $1 AND bill_id = $2',
      [req.user.id, req.params.billId]
    );
    if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Basket item not found.' } });
    const { amountMinor, savedForLater } = req.body || {};
    if (amountMinor !== undefined && amountMinor !== null) {
      if (!isMinorAmount(amountMinor)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Basket amount must be a positive number of minor units.' } });
      }
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.billId]);
      const remaining = bill ? bill.amount_minor - bill.covered_minor : 0;
      if (amountMinor > remaining) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `Only ${remaining / 100} ${bill.currency} is still needed on this bill.` } });
      }
      await db.run('UPDATE basket_items SET amount_minor = $1 WHERE user_id = $2 AND bill_id = $3', [amountMinor, req.user.id, req.params.billId]);
    }
    if (typeof savedForLater === 'boolean') {
      await db.run('UPDATE basket_items SET saved_for_later = $1 WHERE user_id = $2 AND bill_id = $3', [savedForLater ? 1 : 0, req.user.id, req.params.billId]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/basket/:billId', requireActive, async (req, res, next) => {
  try {
    await db.run('DELETE FROM basket_items WHERE user_id = $1 AND bill_id = $2', [req.user.id, req.params.billId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Pledges (items 266–270) ---

function addMonthsClamped(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Clamp month-end overflow (Jan 31 + 1 month -> Feb 28, not Mar 3).
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

function nextDueFrom(frequency, fromMs) {
  const from = new Date(fromMs);
  if (frequency === 'weekly') return new Date(from.getTime() + 7 * 24 * 3600000).toISOString();
  return addMonthsClamped(from, 1).toISOString();
}

function publicPledge(r) {
  return {
    id: r.id,
    billId: r.bill_id,
    billTitle: r.bill_title || '',
    billStatus: r.bill_status || '',
    frequency: r.frequency,
    amountMinor: r.amount_minor,
    currency: r.currency,
    status: r.status,
    nextDueAt: r.next_due_at,
    createdAt: r.created_at,
  };
}

router.post('/pledges', requireActive, rateLimit('pledge-create', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const { billId, frequency, amountMinor } = req.body || {};
    if (!['weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Frequency must be weekly or monthly.' } });
    }
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount must be a positive number of minor units.' } });
    }
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.status !== 'approved' || isExpired(bill)) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only open bills can be pledged to.' } });
    }
    if (bill.user_id === req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot pledge to your own bill.' } });
    }
    const minGift = Number(await db.getSetting(bill.currency === 'INR' ? 'min_gift_minor_inr' : 'min_gift_minor_npr'))
      || Number(await db.getSetting('min_gift_minor')) || 1000;
    if (amountMinor < minGift) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `The minimum pledge amount is ${minGift / 100} ${bill.currency}.` } });
    }
    const existing = await db.get(
      `SELECT id FROM pledges WHERE user_id = $1 AND bill_id = $2 AND status IN ('active', 'paused')`,
      [req.user.id, bill.id]
    );
    if (existing) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'You already have an active pledge on this bill.' } });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO pledges (id, user_id, bill_id, frequency, amount_minor, currency, status, next_due_at, last_reminded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NULL, $8, $8)`,
      [id, req.user.id, bill.id, frequency, amountMinor, bill.currency, nextDueFrom(frequency, Date.now()), now]
    );
    await logAudit('user', req.user.id, 'pledge_created', 'pledge', id, { billId: bill.id, frequency, amountMinor });
    const row = await db.get(
      `SELECT p.*, b.title AS bill_title, b.status AS bill_status FROM pledges p JOIN bills b ON b.id = p.bill_id WHERE p.id = $1`,
      [id]
    );
    res.status(201).json({ pledge: publicPledge(row) });
  } catch (err) {
    next(err);
  }
});

router.get('/pledges/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, b.title AS bill_title, b.status AS bill_status
       FROM pledges p JOIN bills b ON b.id = p.bill_id
       WHERE p.user_id = $1 ORDER BY p.next_due_at ASC`,
      [req.user.id]
    );
    res.json({ pledges: rows.map(publicPledge) });
  } catch (err) {
    next(err);
  }
});

async function loadOwnPledge(req, res) {
  const pledge = await db.get('SELECT * FROM pledges WHERE id = $1', [req.params.id]);
  if (!pledge || pledge.user_id !== req.user.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pledge not found.' } });
    return null;
  }
  return pledge;
}

router.post('/pledges/:id/pause', requireActive, async (req, res, next) => {
  try {
    const pledge = await loadOwnPledge(req, res);
    if (!pledge) return;
    if (pledge.status !== 'active') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only an active pledge can be paused (current: ${pledge.status}).` } });
    }
    await db.run(`UPDATE pledges SET status = 'paused', updated_at = $1 WHERE id = $2`, [nowIso(), pledge.id]);
    res.json({ ok: true, status: 'paused' });
  } catch (err) {
    next(err);
  }
});

router.post('/pledges/:id/resume', requireActive, async (req, res, next) => {
  try {
    const pledge = await loadOwnPledge(req, res);
    if (!pledge) return;
    if (pledge.status !== 'paused') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a paused pledge can be resumed (current: ${pledge.status}).` } });
    }
    // Resume from now: the next gift is due one cycle from today.
    await db.run(
      `UPDATE pledges SET status = 'active', next_due_at = $1, last_reminded_at = NULL, updated_at = $2 WHERE id = $3`,
      [nextDueFrom(pledge.frequency, Date.now()), nowIso(), pledge.id]
    );
    res.json({ ok: true, status: 'active' });
  } catch (err) {
    next(err);
  }
});

router.post('/pledges/:id/cancel', requireActive, async (req, res, next) => {
  try {
    const pledge = await loadOwnPledge(req, res);
    if (!pledge) return;
    if (pledge.status === 'cancelled') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This pledge is already cancelled.' } });
    }
    await db.run(`UPDATE pledges SET status = 'cancelled', updated_at = $1 WHERE id = $2`, [nowIso(), pledge.id]);
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    next(err);
  }
});

// The helper sent this cycle's gift manually: move the next due date one
// cycle forward. No payment is ever taken by the platform.
router.post('/pledges/:id/mark-sent', requireActive, async (req, res, next) => {
  try {
    const pledge = await loadOwnPledge(req, res);
    if (!pledge) return;
    if (pledge.status !== 'active') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only an active pledge can be marked sent (current: ${pledge.status}).` } });
    }
    const base = Math.max(new Date(pledge.next_due_at).getTime(), Date.now());
    const next = nextDueFrom(pledge.frequency, base);
    await db.run(
      `UPDATE pledges SET next_due_at = $1, last_reminded_at = NULL, updated_at = $2 WHERE id = $3`,
      [next, nowIso(), pledge.id]
    );
    res.json({ ok: true, nextDueAt: next });
  } catch (err) {
    next(err);
  }
});

// --- Biller directory, public read (item 272) ---

const BILLER_CATEGORIES = ['electricity', 'water', 'internet', 'school', 'hospital', 'other'];

router.get('/billers', async (req, res, next) => {
  try {
    const country = ['NP', 'IN'].includes(req.query.country) ? req.query.country : null;
    const category = BILLER_CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const params = [];
    let where = 'active = 1';
    if (country) { params.push(country); where += ` AND country = $${params.length}`; }
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM billers WHERE ${where} ORDER BY category ASC, name ASC LIMIT 200`,
      params
    );
    res.json({
      billers: rows.map((r) => ({
        id: r.id, name: r.name, category: r.category, country: r.country,
        refFormat: r.ref_format || '', refHint: r.ref_hint || '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.BILLER_CATEGORIES = BILLER_CATEGORIES;
