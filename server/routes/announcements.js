// Sahay Pay — community updates channel (Phase 2 §7, items 696–698).
// Public: GET /api/announcements lists published announcements
// (publish_at <= now — scheduled items appear lazily on read, no
// scheduler). The admin composer lives in server/routes/admin.js.

'use strict';

const express = require('express');
const db = require('../db');
const { nowIso } = require('../lib/audit');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const { rows } = await db.query(
      `SELECT id, title, body, publish_at, created_at FROM announcements
       WHERE publish_at <= $1 ORDER BY publish_at DESC, created_at DESC LIMIT $2`,
      [nowIso(), limit]
    );
    res.json({
      announcements: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body,
        publishAt: r.publish_at, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
