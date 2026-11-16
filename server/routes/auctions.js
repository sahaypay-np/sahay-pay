// Sahay Pay — auctions routes (an original, moderated extension).
// GET /api/auctions, GET /api/auctions/:id (public, approved only),
// POST /api/auctions (-> pending_review), POST /api/auctions/:id/bid,
// GET /api/auctions/mine.
// Bidding: no self-bidding; must exceed the current highest bid by at least
// the minimum increment (5% of the current bid, min 1000 minor).
// Real payment/transfer for auctions stays DISABLED (Demo Mode).

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { isMinorAmount } = require('../lib/money');
const { createReviewPacket, createNotification } = require('../lib/notify');

const router = express.Router();

function minIncrement(currentMinor) {
  return Math.max(1000, Math.ceil(currentMinor * 0.05));
}

async function withBids(row) {
  const { rows } = await db.query(
    `SELECT ab.*, u.display_name AS bidder_name, u.username AS bidder_username
     FROM auction_bids ab JOIN users u ON u.id = ab.bidder_id
     WHERE ab.auction_id = $1 ORDER BY ab.amount_minor DESC LIMIT 50`,
    [row.id]
  );
  const highest = rows[0] ? Number(rows[0].amount_minor) : Number(row.start_bid_minor);
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    photoUrl: row.photo_url,
    category: row.category,
    country: row.country,
    startBidMinor: row.start_bid_minor,
    currency: row.currency,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    currentBidMinor: highest,
    minNextBidMinor: highest + minIncrement(highest),
    bidCount: rows.length,
    bids: rows.map((b) => ({
      id: b.id, amountMinor: b.amount_minor, bidderName: b.bidder_name,
      bidderUsername: b.bidder_username, createdAt: b.created_at,
    })),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM auctions WHERE status = 'approved' AND ends_at > $1 ORDER BY ends_at ASC LIMIT 100`,
      [nowIso()]
    );
    const auctions = [];
    for (const r of rows) auctions.push(await withBids(r));
    res.json({
      auctions,
      emptyMessage: auctions.length === 0 ? 'No live auctions yet.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM auctions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    const auctions = [];
    for (const r of rows) auctions.push(await withBids(r));
    res.json({ auctions });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireActive, rateLimit('post-auction', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const title = cleanStr(body.title, 120);
    if (title.length < 3) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please give your listing a title (3–120 characters).' } });
    const description = cleanStr(body.description, 1500);
    if (description.length < 20) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please describe the item (20–1500 characters).' } });
    if (!isMinorAmount(body.startBidMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Starting bid must be a positive amount in minor units.' } });
    }
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now() + 60 * 60 * 1000) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'The auction must end at least 1 hour from now.' } });
    }
    const currency = req.user.country === 'IN' ? 'INR' : 'NPR';
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO auctions (id, user_id, title, description, photo_url, category, country, start_bid_minor, currency, ends_at, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_review', $11)`,
      [
        id, req.user.id, title, description,
        body.photoUrl ? cleanStr(body.photoUrl, 500) : null,
        cleanStr(body.category || 'Other', 60), req.user.country,
        body.startBidMinor, currency, endsAt.toISOString(), nowIso(),
      ]
    );
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [id]);
    const packet = await createReviewPacket('auction', id, {
      kind: 'auction',
      auctionId: id,
      title,
      description,
      category: auction.category,
      country: auction.country,
      startBidMinor: auction.start_bid_minor,
      currency,
      endsAt: auction.ends_at,
      seller: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'auction_submitted', 'auction', id, {});
    res.status(201).json({ auction: await withBids(auction), reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/bid', requireActive, rateLimit('bid', 30, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction || auction.status !== 'approved') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    }
    if (new Date(auction.ends_at).getTime() <= Date.now()) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This auction has ended.' } });
    }
    if (auction.user_id === req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot bid on your own auction.' } });
    }
    const amountMinor = req.body?.amountMinor;
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Bid must be a positive amount in minor units.' } });
    }
    const current = await withBids(auction);
    if (amountMinor < current.minNextBidMinor) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `Your bid must be at least ${current.minNextBidMinor / 100} ${auction.currency} (current highest + minimum increment).` },
      });
    }
    const previousHighest = current.bids[0];
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO auction_bids (id, auction_id, bidder_id, amount_minor, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, auction.id, req.user.id, amountMinor, nowIso()]
    );
    if (previousHighest && previousHighest.bidderUsername !== req.user.username) {
      const prevBidder = await db.get('SELECT id FROM users WHERE username = $1', [previousHighest.bidderUsername]);
      if (prevBidder) {
        await createNotification(
          prevBidder.id, 'auction_outbid', 'You were outbid',
          `Someone bid ${amountMinor / 100} ${auction.currency} on "${auction.title}".`,
          `#/auction/${auction.id}`
        );
      }
    }
    await logAudit('user', req.user.id, 'auction_bid', 'auction', auction.id, { bidId: id, amountMinor });
    const updated = await db.get('SELECT * FROM auctions WHERE id = $1', [auction.id]);
    res.status(201).json({ auction: await withBids(updated), demoMode: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    const isOwner = req.user && req.user.id === auction.user_id;
    if (auction.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    }
    const seller = await db.get('SELECT display_name, username, photo_url FROM users WHERE id = $1', [auction.user_id]);
    const out = await withBids(auction);
    out.seller = seller ? { displayName: seller.display_name, username: seller.username, photoUrl: seller.photo_url } : null;
    res.json({ auction: out });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
