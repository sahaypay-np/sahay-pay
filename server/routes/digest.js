// Sahay Pay — weekly digest + monthly summary (Phase 2 §7, items 654–658).
// In-app only (no email channel exists). Both are lazy-computed on visit
// from the gifts table — no scheduler, no stored digest rows.
// GET /api/digest/weekly — last 7 days, gifts given/received + new bills
//   in the user's city.
// GET /api/digest/monthly — current calendar month + leaderboard position.
// POST /api/digest/opt-out | /opt-in (655: one-tap unsubscribe).

'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

async function getPrefs(userId) {
  const user = await db.get('SELECT prefs_json FROM users WHERE id = $1', [userId]);
  try { return JSON.parse(user?.prefs_json || '{}'); } catch { return {}; }
}

async function digestFigures(userId, sinceIso, currency) {
  const given = await db.get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(amount_minor),0) AS total
     FROM gifts WHERE supporter_id = $1 AND status = 'confirmed' AND confirmed_at >= $2`,
    [userId, sinceIso]
  );
  const received = await db.get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(g.amount_minor),0) AS total
     FROM gifts g JOIN bills b ON b.id = g.bill_id
     WHERE b.user_id = $1 AND g.status = 'confirmed' AND g.confirmed_at >= $2`,
    [userId, sinceIso]
  );
  const billsHelped = await db.get(
    `SELECT COUNT(DISTINCT bill_id) AS c FROM gifts
     WHERE supporter_id = $1 AND status = 'confirmed' AND confirmed_at >= $2`,
    [userId, sinceIso]
  );
  return {
    currency,
    given: { count: Number(given?.c || 0), totalMinor: Number(given?.total || 0) },
    received: { count: Number(received?.c || 0), totalMinor: Number(received?.total || 0) },
    billsHelped: Number(billsHelped?.c || 0),
  };
}

router.get('/weekly', requireAuth, async (req, res, next) => {
  try {
    const prefs = await getPrefs(req.user.id);
    if (prefs.digestOptOut === true) return res.json({ optedOut: true });
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const figures = await digestFigures(req.user.id, since, req.user.country === 'IN' ? 'INR' : 'NPR');
    // New bills in the user's city this week (for the digest card).
    const newBills = await db.get(
      `SELECT COUNT(*) AS c FROM bills
       WHERE status = 'approved' AND city = $1 AND created_at >= $2`,
      [req.user.city, since]
    );
    res.json({ ...figures, since, newBillsInCity: Number(newBills?.c || 0), optedOut: false });
  } catch (err) {
    next(err);
  }
});

router.get('/monthly', requireAuth, async (req, res, next) => {
  try {
    const prefs = await getPrefs(req.user.id);
    if (prefs.digestOptOut === true) return res.json({ optedOut: true });
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const currency = req.user.country === 'IN' ? 'INR' : 'NPR';
    const figures = await digestFigures(req.user.id, since, currency);
    // Leaderboard position this month (confirmed gifts, same currency).
    const rankRows = await db.query(
      `SELECT g.supporter_id, SUM(g.amount_minor) AS total
       FROM gifts g WHERE g.status = 'confirmed' AND g.confirmed_at >= $1 AND g.currency = $2
       GROUP BY g.supporter_id ORDER BY total DESC`,
      [since, currency]
    );
    const rankIndex = rankRows.rows.findIndex((r) => r.supporter_id === req.user.id);
    res.json({
      ...figures,
      since,
      month: since.slice(0, 7),
      leaderboardRank: rankIndex >= 0 ? rankIndex + 1 : null,
      leaderboardTotal: rankRows.rows.length,
      optedOut: false,
    });
  } catch (err) {
    next(err);
  }
});

async function setOptOut(req, res, optedOut) {
  const user = await db.get('SELECT prefs_json FROM users WHERE id = $1', [req.user.id]);
  let prefs = {};
  try { prefs = JSON.parse(user?.prefs_json || '{}'); } catch { prefs = {}; }
  prefs.digestOptOut = optedOut;
  await db.run('UPDATE users SET prefs_json = $1 WHERE id = $2', [JSON.stringify(prefs), req.user.id]);
  res.json({ ok: true, optedOut });
}

router.post('/opt-out', requireAuth, (req, res, next) => setOptOut(req, res, true).catch(next));
router.post('/opt-in', requireAuth, (req, res, next) => setOptOut(req, res, false).catch(next));

module.exports = router;
